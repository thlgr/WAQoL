# WAQoL

Fix Whatsapp Web lagginess. This userscripts applies patches as an attempt to make the web app more smooth on Chromium based browsers.

## How it works

The browser has to draw each message as it comes into the screen, if it can't keep up, scrolling looks choppy.

After researching for a long time, I figured out this CSS rule fixes this issue (in my machine, the chat history scrolling goes from 15 fps to a full 60 fps):

```css
[data-testid="conversation-panel-messages"] {
  will-change: scroll-position !important;
}
```

This tells the browser to get ready for scrolling, indicating it can optimize the rendering of overflowing content. That keeps scrolling fast and smooth without slowing down the rest of the page. 

Other patches are applied to reduce CPU work.

## Install

1. Install a userscript manager ([Violentmonkey](https://violentmonkey.github.io/), [Tampermonkey](https://www.tampermonkey.net/), etc).
2. Make sure to enable user scripts in extension settings.
3. [Install](https://github.com/thlgr/WAQoL/raw/refs/heads/main/waqol.user.js)

The script has some fallbacks in case WhatsApp Web updates, but in case the patches starts failing open an issue.