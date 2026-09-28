// OS notifications. On macOS the notification plugin posts through the deprecated
// NSUserNotificationCenter under a swizzled bundle id; macOS never registers the app for it (the
// plugin's permission request is a stub that answers "granted"), so release builds were silently
// dropped. Only dev worked, because the plugin posts as Terminal there. A bundled macOS build goes
// through UNUserNotificationCenter instead: it prompts, lists Lookout in Notification settings, and
// reports clicks. Anything else (`tauri dev`, other OSes) keeps the plugin.

use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;

// Emitted with the notification's `extra` payload when the user clicks it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const CLICK_EVENT: &str = "notification-click";

pub fn init<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    if native::available() {
        native::set_delegate(app.clone());
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[tauri::command]
pub async fn notification_permission() -> bool {
    #[cfg(target_os = "macos")]
    if native::available() {
        return native::request_permission().await;
    }
    true
}

// "granted" | "denied" | "prompt" (never asked), read without prompting
#[tauri::command]
pub async fn notification_status() -> &'static str {
    #[cfg(target_os = "macos")]
    if native::available() {
        return native::status().await;
    }
    "granted"
}

// macOS only shows its prompt once: after a "Don't Allow" the only way back is System Settings
#[tauri::command]
pub fn notification_open_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = format!(
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id={}",
            app.config().identifier
        );
        std::process::Command::new("open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

#[tauri::command]
pub fn notification_send<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: String,
    extra: Option<serde_json::Value>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if native::available() {
        native::send(&title, &body, extra.as_ref());
        return Ok(());
    }
    let _ = extra;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
mod native {
    use std::ptr::NonNull;
    use std::sync::OnceLock;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
    use objc2_foundation::{ns_string, NSBundle, NSDictionary, NSError, NSString, NSUUID};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };
    use tauri::{AppHandle, Emitter, Runtime};

    use super::CLICK_EVENT;

    // UNUserNotificationCenter raises (and aborts the process) when the executable isn't inside an
    // app bundle, which is exactly the `tauri dev` binary.
    pub fn available() -> bool {
        static BUNDLED: OnceLock<bool> = OnceLock::new();
        *BUNDLED.get_or_init(|| NSBundle::mainBundle().bundlePath().to_string().ends_with(".app"))
    }

    // Idempotent: prompts on first launch only, then answers from the stored decision.
    pub async fn request_permission() -> bool {
        // the block isn't Send, so it must be gone before the await
        let rx = ask_permission();
        rx.await.unwrap_or(false)
    }

    fn ask_permission() -> tokio::sync::oneshot::Receiver<bool> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = std::sync::Mutex::new(Some(tx));
        let handler = RcBlock::new(move |granted: Bool, _err: *mut NSError| {
            if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                let _ = tx.send(granted.as_bool());
            }
        });
        UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &handler,
        );
        rx
    }

    pub async fn status() -> &'static str {
        let rx = ask_status();
        rx.await.unwrap_or("prompt")
    }

    fn ask_status() -> tokio::sync::oneshot::Receiver<&'static str> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = std::sync::Mutex::new(Some(tx));
        let handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            // SAFETY: the completion handler always gets a valid settings object
            let status = match unsafe { settings.as_ref() }.authorizationStatus() {
                UNAuthorizationStatus::NotDetermined => "prompt",
                UNAuthorizationStatus::Denied => "denied",
                _ => "granted",
            };
            if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                let _ = tx.send(status);
            }
        });
        UNUserNotificationCenter::currentNotificationCenter().getNotificationSettingsWithCompletionHandler(&handler);
        rx
    }

    pub fn send(title: &str, body: &str, extra: Option<&serde_json::Value>) {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        if let Some(extra) = extra {
            let value = NSString::from_str(&extra.to_string());
            let info = NSDictionary::from_slices(&[ns_string!("extra")], &[&*value]);
            // SAFETY: userInfo is typed as an untyped dictionary; string keys and values are valid in it
            unsafe { content.setUserInfo(&Retained::cast_unchecked::<NSDictionary>(info)) };
        }
        let id = NSUUID::new().UUIDString();
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
        let done = RcBlock::new(|err: *mut NSError| {
            // SAFETY: the completion handler gets either null or a valid NSError
            if let Some(err) = unsafe { err.as_ref() } {
                log::warn!("notification not delivered: {}", err.localizedDescription());
            }
        });
        UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(
            &request,
            Some(&done),
        );
    }

    pub fn set_delegate<R: Runtime>(app: AppHandle<R>) {
        let emit: Box<dyn Fn(serde_json::Value) + Send + Sync> = Box::new(move |extra| {
            let _ = app.emit(CLICK_EVENT, extra);
        });
        let delegate = Delegate::new(emit);
        UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // the center holds its delegate weakly; it has to live as long as the app
        std::mem::forget(delegate);
    }

    pub struct Ivars {
        emit: Box<dyn Fn(serde_json::Value) + Send + Sync>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "LookoutNotificationDelegate"]
        #[ivars = Ivars]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            // show the banner even while Lookout is frontmost (macOS hides it by default)
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                handler: &block2::DynBlock<dyn Fn()>,
            ) {
                let info = response.notification().request().content().userInfo();
                let extra = info
                    .objectForKey(ns_string!("extra"))
                    .and_then(|v: Retained<AnyObject>| v.downcast::<NSString>().ok())
                    .and_then(|s| serde_json::from_str(&s.to_string()).ok())
                    .unwrap_or(serde_json::Value::Null);
                (self.ivars().emit)(extra);
                handler.call(());
            }
        }
    );

    impl Delegate {
        fn new(emit: Box<dyn Fn(serde_json::Value) + Send + Sync>) -> Retained<Self> {
            let this = Self::alloc().set_ivars(Ivars { emit });
            // SAFETY: NSObject's designated initializer
            unsafe { msg_send![super(this), init] }
        }
    }
}
