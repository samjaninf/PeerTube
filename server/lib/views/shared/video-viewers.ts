import { Transaction } from 'sequelize/types'
import { isTestInstance } from '@server/helpers/core-utils'
import { GeoIP } from '@server/helpers/geo-ip'
import { logger, loggerTagsFactory } from '@server/helpers/logger'
import { MAX_LOCAL_VIEWER_WATCH_SECTIONS, VIEW_LIFETIME } from '@server/initializers/constants'
import { sequelizeTypescript } from '@server/initializers/database'
import { sendCreateWatchAction } from '@server/lib/activitypub/send'
import { getLocalVideoViewerActivityPubUrl } from '@server/lib/activitypub/url'
import { PeerTubeSocket } from '@server/lib/peertube-socket'
import { Redis } from '@server/lib/redis'
import { VideoModel } from '@server/models/video/video'
import { LocalVideoViewerModel } from '@server/models/view/local-video-viewer'
import { LocalVideoViewerWatchSectionModel } from '@server/models/view/local-video-viewer-watch-section'
import { MVideo } from '@server/types/models'
import { VideoViewEvent } from '@shared/models'

const lTags = loggerTagsFactory('views')

type LocalViewerStats = {
  firstUpdated: number // Date.getTime()
  lastUpdated: number // Date.getTime()

  watchSections: {
    start: number
    end: number
  }[]

  watchTime: number

  country: string

  videoId: number
}

export class VideoViewers {

  // Values are Date().getTime()
  private readonly viewersPerVideo = new Map<number, number[]>()

  private processingViewerCounters = false
  private processingViewerStats = false

  constructor () {
    setInterval(() => this.cleanViewerCounters(), VIEW_LIFETIME.VIEWER_COUNTER)

    setInterval(() => this.processViewerStats(), VIEW_LIFETIME.VIEWER_STATS)
  }

  // ---------------------------------------------------------------------------

  getViewers (video: MVideo) {
    const viewers = this.viewersPerVideo.get(video.id)
    if (!viewers) return 0

    return viewers.length
  }

  buildViewerExpireTime () {
    return new Date().getTime() + VIEW_LIFETIME.VIEWER_COUNTER
  }

  async getWatchTime (videoId: number, ip: string) {
    const stats: LocalViewerStats = await Redis.Instance.getLocalVideoViewer({ ip, videoId })

    return stats?.watchTime || 0
  }

  async addLocalViewer (options: {
    video: MVideo
    currentTime: number
    ip: string
    viewEvent?: VideoViewEvent
  }) {
    const { video, ip, viewEvent, currentTime } = options

    logger.debug('Adding local viewer to video %s.', video.uuid, { currentTime, viewEvent, ...lTags(video.uuid) })

    await this.updateLocalViewerStats({ video, viewEvent, currentTime, ip })

    const viewExists = await Redis.Instance.doesVideoIPViewerExist(ip, video.uuid)
    if (viewExists) return false

    await Redis.Instance.setIPVideoViewer(ip, video.uuid)

    return this.addViewerToVideo({ video })
  }

  async addRemoteViewer (options: {
    video: MVideo
    viewerExpires: Date
  }) {
    const { video, viewerExpires } = options

    logger.debug('Adding remote viewer to video %s.', video.uuid, { ...lTags(video.uuid) })

    return this.addViewerToVideo({ video, viewerExpires })
  }

  private async addViewerToVideo (options: {
    video: MVideo
    viewerExpires?: Date
  }) {
    const { video, viewerExpires } = options

    let watchers = this.viewersPerVideo.get(video.id)

    if (!watchers) {
      watchers = []
      this.viewersPerVideo.set(video.id, watchers)
    }

    const expiration = viewerExpires
      ? viewerExpires.getTime()
      : this.buildViewerExpireTime()

    watchers.push(expiration)
    await this.notifyClients(video.id, watchers.length)

    return true
  }

  private async updateLocalViewerStats (options: {
    video: MVideo
    ip: string
    currentTime: number
    viewEvent?: VideoViewEvent
  }) {
    const { video, ip, viewEvent, currentTime } = options
    const nowMs = new Date().getTime()

    let stats: LocalViewerStats = await Redis.Instance.getLocalVideoViewer({ ip, videoId: video.id })

    if (stats && stats.watchSections.length >= MAX_LOCAL_VIEWER_WATCH_SECTIONS) {
      logger.warn('Too much watch section to store for a viewer, skipping this one', { currentTime, viewEvent, ...lTags(video.uuid) })
      return
    }

    if (!stats) {
      const country = await GeoIP.Instance.safeCountryISOLookup(ip)

      stats = {
        firstUpdated: nowMs,
        lastUpdated: nowMs,

        watchSections: [],

        watchTime: 0,

        country,
        videoId: video.id
      }
    }

    stats.lastUpdated = nowMs

    if (viewEvent === 'seek' || stats.watchSections.length === 0) {
      stats.watchSections.push({
        start: currentTime,
        end: currentTime
      })
    } else {
      const lastSection = stats.watchSections[stats.watchSections.length - 1]
      lastSection.end = currentTime
    }

    stats.watchTime = this.buildWatchTimeFromSections(stats.watchSections)

    logger.debug('Set local video viewer stats for video %s.', video.uuid, { stats, ...lTags(video.uuid) })

    await Redis.Instance.setLocalVideoViewer(ip, video.id, stats)
  }

  private async cleanViewerCounters () {
    if (this.processingViewerCounters) return
    this.processingViewerCounters = true

    if (!isTestInstance()) logger.info('Cleaning video viewers.', lTags())

    try {
      for (const videoId of this.viewersPerVideo.keys()) {
        const notBefore = new Date().getTime()

        const viewers = this.viewersPerVideo.get(videoId)

        // Only keep not expired viewers
        const newViewers = viewers.filter(w => w > notBefore)

        if (newViewers.length === 0) this.viewersPerVideo.delete(videoId)
        else this.viewersPerVideo.set(videoId, newViewers)

        await this.notifyClients(videoId, newViewers.length)
      }
    } catch (err) {
      logger.error('Error in video clean viewers scheduler.', { err, ...lTags() })
    }

    this.processingViewerCounters = false
  }

  private async notifyClients (videoId: string | number, viewersLength: number) {
    const video = await VideoModel.loadImmutableAttributes(videoId)
    if (!video) return

    PeerTubeSocket.Instance.sendVideoViewsUpdate(video, viewersLength)

    logger.debug('Video viewers update for %s is %d.', video.url, viewersLength, lTags())
  }

  async processViewerStats () {
    if (this.processingViewerStats) return
    this.processingViewerStats = true

    if (!isTestInstance()) logger.info('Processing viewer statistics.', lTags())

    const now = new Date().getTime()

    try {
      const allKeys = await Redis.Instance.listLocalVideoViewerKeys()

      for (const key of allKeys) {
        const stats: LocalViewerStats = await Redis.Instance.getLocalVideoViewer({ key })

        // Process expired stats
        if (stats.lastUpdated > now - VIEW_LIFETIME.VIEWER_STATS) {
          continue
        }

        try {
          await sequelizeTypescript.transaction(async t => {
            const video = await VideoModel.load(stats.videoId, t)

            const statsModel = await this.saveViewerStats(video, stats, t)

            if (video.remote) {
              await sendCreateWatchAction(statsModel, t)
            }
          })

          await Redis.Instance.deleteLocalVideoViewersKeys(key)
        } catch (err) {
          logger.error('Cannot process viewer stats for Redis key %s.', key, { err, ...lTags() })
        }
      }
    } catch (err) {
      logger.error('Error in video save viewers stats scheduler.', { err, ...lTags() })
    }

    this.processingViewerStats = false
  }

  private async saveViewerStats (video: MVideo, stats: LocalViewerStats, transaction: Transaction) {
    const statsModel = new LocalVideoViewerModel({
      startDate: new Date(stats.firstUpdated),
      endDate: new Date(stats.lastUpdated),
      watchTime: stats.watchTime,
      country: stats.country,
      videoId: video.id
    })

    statsModel.url = getLocalVideoViewerActivityPubUrl(statsModel)
    statsModel.Video = video as VideoModel

    await statsModel.save({ transaction })

    statsModel.WatchSections = await LocalVideoViewerWatchSectionModel.bulkCreateSections({
      localVideoViewerId: statsModel.id,
      watchSections: stats.watchSections,
      transaction
    })

    return statsModel
  }

  private buildWatchTimeFromSections (sections: { start: number, end: number }[]) {
    return sections.reduce((p, current) => p + (current.end - current.start), 0)
  }
}
