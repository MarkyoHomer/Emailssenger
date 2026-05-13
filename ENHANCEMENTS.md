# Palawan Connect - Chat Enhancements

## ✅ Implemented Features

### 1. **Quote/Reply Feature**
- Click the **↩️** icon on any message to quote it
- Quoted message appears in a preview bar above the input
- Click **✕** to cancel the quote
- Quoted messages show the original sender and text
- Click on a quote block to scroll to the original message

### 2. **Browser Notifications**
- Desktop notifications for new messages when window is not focused
- Click **🔔 Notify** button in topbar to enable (appears if permission not granted)
- Notifications show sender name, channel, and message preview
- Click notification to focus window and jump to that channel
- In-app toast notifications for messages in background channels

### 3. **Smaller Font Sizes**
- Reduced base font from 14px to 13px throughout
- Compact UI elements (buttons, inputs, avatars)
- Tighter spacing for a more professional look
- Improved information density

### 4. **Edit Own Messages**
- Click **✏️** icon on your own messages to edit
- Inline editing with textarea
- Save or cancel buttons
- Edited messages show "(edited)" tag
- Cannot edit while offline

### 5. **Multiline Chat Input**
- Press **Shift+Enter** to add new lines
- Press **Enter** alone to send
- Auto-resizing textarea (up to 120px height)
- Placeholder updated to show keyboard shortcut

### 6. **Microsoft Teams Color Theme**
- Dark purple/blue palette inspired by MS Teams
- Primary color: `#6264a7` (Teams purple)
- Sidebar: Dark navy `#1e1f3b`
- Messages area: Black background `#0d0d1a`
- Accent colors for buttons and highlights
- Professional gradient-free design

### 7. **Black Background**
- Messages area uses true black background (`#0d0d1a`)
- Dark theme throughout entire app
- High contrast for better readability
- Message bubbles with subtle borders
- Dark modals and panels

## 🎨 Visual Changes

- **Topbar**: Dark navy with compact 48px height
- **Sidebar**: Dark purple-navy with smaller fonts
- **Message Bubbles**: Dark background for others, purple gradient for own messages
- **Scrollbar**: Thin purple scrollbar (4px width)
- **Buttons**: Rounded corners, purple accent color
- **Modals**: Dark theme with purple accents
- **Status Indicators**: MS Teams colors (green, yellow, red, gray)

## 🔧 Technical Details

### New State Properties
```javascript
state.quoteMsg = null; // Currently quoted message
```

### New Functions
- `quoteMessage(msgId)` - Set a message to be quoted
- `cancelQuote()` - Clear quote preview
- `scrollToMsg(msgId)` - Scroll to and highlight a message
- `startEdit(msgId)` - Enter edit mode for a message
- `saveEdit(msgId)` - Save edited message to Firestore
- `cancelEdit(msgId)` - Cancel editing
- `requestNotificationPermission()` - Request browser notification permission
- `showBrowserNotification(title, body, channelId)` - Show desktop notification
- `showNotifToast(title, body)` - Show in-app notification toast
- `checkNotificationPermission()` - Check and show notification button if needed

### Updated Functions
- `appendMessageEl()` - Now supports quote blocks, edit button, and quote action
- `sendMessage()` - Includes quote data when sending
- `loadChannel()` - Triggers notifications for new messages from others
- `saveSettings()` - Now saves display name changes

### New CSS Classes
- `.msg-quote` - Quote block styling
- `.quote-preview` - Quote preview bar above input
- `.msg-edit-area` - Edit textarea
- `.msg-edit-actions` - Edit save/cancel buttons
- `.msg-edited-tag` - "(edited)" indicator
- `.notif-toast` - In-app notification toast
- Dark theme color variables in `:root`

## 🚀 Usage

1. **Quote a message**: Hover over any message and click the ↩️ icon
2. **Edit your message**: Hover over your own message and click the ✏️ icon
3. **Enable notifications**: Click the 🔔 Notify button in the topbar
4. **Multiline input**: Press Shift+Enter to add new lines, Enter to send
5. **Jump to quoted message**: Click on a quote block to scroll to the original

## 📱 Compatibility

- Works with existing offline mode
- SMS messages can be quoted
- Notifications respect browser focus state
- Edit feature requires online connection
- All features gracefully degrade when offline

## 🎯 Future Enhancements

- Message threading
- Rich text formatting
- Code syntax highlighting
- File preview in quotes
- Notification sound customization
- Dark/light theme toggle
