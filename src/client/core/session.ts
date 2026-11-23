import type { Room } from '@colyseus/sdk'
import { client } from './network'

/**
 * Reconnection token of the current game room, kept in sessionStorage so a page reload can take
 * the seat back (the server holds it for a while after a drop). Per tab, so two tabs never fight
 * over one seat. Storage can be unavailable or throw, so failures just disable resuming.
 */
const TOKEN_KEY = 'mini-games.reconnectionToken'

const loadToken = (): string => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

const saveToken = (token: string) => {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // Storage unavailable — a reload just won't resume the session
  }
}

/**
 * The game room the player is in, if any. Lives outside the scenes, so the connection
 * outlives the Lobby scene that opened it.
 */
export let currentRoom: Room | undefined

export const setCurrentRoom = (room: Room | undefined) => {
  currentRoom = room
  saveToken(room?.reconnectionToken ?? '')
  if (!room) return

  // Every reconnect (the SDK's own, after a network blip) hands out a new token, but the SDK
  // fires onReconnect before it stores it, so read it once the handshake has finished
  room.onReconnect(() => queueMicrotask(() => {
    if (currentRoom === room) saveToken(room.reconnectionToken)
  }))
  // Kicked, room disposed, or the seat expired: nothing left to resume
  room.onLeave(() => {
    if (currentRoom !== room) return
    currentRoom = undefined
    saveToken('')
  })
}

/** Leave the current game room (if any) for good. */
export const leaveCurrentRoom = () => {
  const room = currentRoom
  currentRoom = undefined
  saveToken('')
  room?.leave().catch(() => { /* already gone */ })
}

/** A game room from before a page reload may still be resumable. */
export const hasResumableSession = () => loadToken() !== ''

/**
 * Take back the seat in the game room this tab was in before a reload. Resolves to the room,
 * or `undefined` if there is nothing to resume (seat expired, room gone).
 */
export const resumeSession = async (): Promise<Room | undefined> => {
  const token = loadToken()
  if (!token) return undefined

  try {
    const room = await client.reconnect(token)
    setCurrentRoom(room)
    return room
  } catch (e) {
    console.warn('Resuming the previous room failed', e)
    saveToken('')
    return undefined
  }
}
