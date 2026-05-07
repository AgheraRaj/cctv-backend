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
    getProfiles(cb: (err: Error | null, profiles: any[]) => void): void
  }
}