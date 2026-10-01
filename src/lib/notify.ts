import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

type NotificationExtra = { alertKey?: string; taskId?: string; view?: string } // view: a tab to open (Stream digest)
export type NotificationStatus = 'granted' | 'denied' | 'prompt'

let enabled = true // the Settings switch (config.notifications)
let granted: boolean | null = null

export const setNotificationsEnabled = (on: boolean) => {
  enabled = on
}

// Goes through Rust: bundled macOS builds use UNUserNotificationCenter, everything else the plugin.
export const notify = async (title: string, body: string, extra?: Record<string, unknown>) => {
  if (!enabled) return
  if (granted === null) granted = await invoke<boolean>('notification_permission')
  if (granted) await invoke('notification_send', { title, body, extra })
}

// read without prompting
export const notificationStatus = () => invoke<NotificationStatus>('notification_status')

// shows the OS prompt the first time only; after that it answers from the stored decision
export const requestNotifications = async () => {
  granted = await invoke<boolean>('notification_permission')
  return granted
}

export const openNotificationSettings = () => invoke('notification_open_settings')

// Fires when the OS notification is clicked. Delivered by the macOS app bundle only — `tauri dev`
// posts as Terminal, so a click there opens Terminal instead.
export const onNotificationClick = (cb: (extra: NotificationExtra) => void) =>
  listen<NotificationExtra | null>('notification-click', (e) => cb(e.payload ?? {}))
