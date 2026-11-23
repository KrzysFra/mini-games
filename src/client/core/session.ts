import type { Room } from '@colyseus/sdk'

/**
 * The game room the player is in, if any. Lives outside the scenes, so the connection
 * outlives the Lobby scene that opened it.
 */
export let currentRoom: Room | undefined

export const setCurrentRoom = (room: Room | undefined) => {
  currentRoom = room
}

/** Leave the current game room (if any) for good. */
export const leaveCurrentRoom = () => {
  const room = currentRoom
  currentRoom = undefined
  room?.leave().catch(() => { /* already gone */ })
}
