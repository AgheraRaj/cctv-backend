declare module 'onvif' {
  export class Cam {
    constructor(
      options: {
        hostname: string
        username: string
        password: string
        port: number
      },
      callback: (this: Cam, err: Error | null) => void
    )

    /** Get media profiles */
    getProfiles(
      cb: (err: Error | null, profiles: any[]) => void
    ): void

    /**
     * GetRecordingSummary (search service)
     * Returns overall recording availability window.
     * linerase auto-converts ISO datetime strings to Date objects.
     */
    getRecordingSummary(
      cb: (
        err: Error | null,
        result: {
          dataFrom: Date
          dataUntil: Date
          numberRecordings: number
        }
      ) => void
    ): void

    /**
     * GetRecordings (recording service)
     * Returns all recording tokens with source + track metadata.
     * Result is RecordingItem or RecordingItem[] depending on count.
     */
    getRecordings(
      cb: (
        err: Error | null,
        items: {
          $: { token: string }
          configuration?: {
            source?: { sourceid?: string; name?: string }
            content?: string
          }
          tracks?: {
            track?: {
              $?: { token: string }
              configuration?: { tracktype?: string; description?: string }
            } | Array<{
              $?: { token: string }
              configuration?: { tracktype?: string; description?: string }
            }>
          }
        } | Array<{
          $: { token: string }
          configuration?: {
            source?: { sourceid?: string; name?: string }
          }
        }>
      ) => void
    ): void

    /**
     * GetRecordingInformation (search service)
     * Returns time range and track detail for a specific recording token.
     * linerase auto-converts ISO datetime strings to Date objects.
     */
    getRecordingInformation(
      options: { RecordingToken: string },
      cb: (
        err: Error | null,
        result: {
          recordingToken?: string
          source?: { sourceId?: string; name?: string }
          earliestRecording?: Date
          latestRecording?: Date
          recordingStatus?: string
          track?: Array<{
            trackToken?: string
            trackType?: string
            dataFrom?: Date
            dataTo?: Date
          }>
        }
      ) => void
    ): void

    /**
     * GetReplayUri (replay service)
     * Returns the RTSP URL for playing back a specific recording token.
     */
    getReplayUri(
      options: {
        recordingToken: string
        stream?: string      // default: 'RTP-Unicast'
        protocol?: string    // default: 'RTSP'
      },
      cb: (err: Error | null, uri: string) => void
    ): void
  }
}