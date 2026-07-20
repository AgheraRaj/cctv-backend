import { Server as HttpServer } from 'http'
import { Server as SocketServer } from 'socket.io'


// ─── Types ────────────────────────────────────────────────

export interface NvrStatusPayload {
  nvrId: string
  status: 'ONLINE' | 'OFFLINE'
  lastSeenAt: Date | null
  offlineSince: Date | null
}

export interface CameraStatusPayload {
  cameraId: string
  nvrId: string
  channel: number
  isOnline: boolean
  offlineSince: Date | null
}

export interface CameraNewPayload {
  camera: {
    id: string
    nvrId: string
    channel: number
    name: string
    isOnline: boolean
  }
}

// ─── Singleton ────────────────────────────────────────────

let io: SocketServer | null = null

export const initSocketService = (httpServer: HttpServer): SocketServer => {
  io = new SocketServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  })

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`)

    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`)
    })
  })

  console.log('Socket.io initialized')
  return io
}

export const getIO = (): SocketServer => {
  if (!io) throw new Error('Socket.io not initialized. Call initSocketService() first.')
  return io
}

// ─── Emit Helpers ─────────────────────────────────────────

export const emitNvrStatus = (payload: NvrStatusPayload): void => {
  try {
    getIO().emit('nvr:status', payload)
  } catch {
    // Socket not yet initialized — silently skip (e.g. during startup)
  }
}

export const emitCameraStatus = (payload: CameraStatusPayload): void => {
  try {
    getIO().emit('camera:status', payload)
  } catch {
    // Socket not yet initialized — silently skip
  }
}

export const emitCameraNew = (payload: CameraNewPayload): void => {
  try {
    getIO().emit('camera:new', payload)
  } catch {
    // Socket not yet initialized — silently skip
  }
}
