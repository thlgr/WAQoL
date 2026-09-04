# WAQoL

Fix Whatsapp Web lagginess. This userscripts applies patches as an attempt to make the web app more smooth on Chromium based browsers.

## How it works

Message panel scrolls on the main thread, so the browser has to check every frame if the content needs repainting or handle events before it can update the UI. This makes the scrolling visibly choppy.

After researching for a long time I figured out this CSS rule fixes this issue (in my machine, the chat history scrolling goes from 15 fps to a full 60 fps):

```css
[data-testid="conversation-panel-messages"] {
  will-change: scroll-position !important;
}
```

This tells the browser to get ready for scrolling. By creating a separate visual layer on the GPU, it can move the screen up and down directly. That keeps scrolling fast and smooth without slowing down the rest of the page. 

Other patches are applied to reduce CPU work.

## Install

1. Install a userscript manager ([Violentmonkey](https://violentmonkey.github.io/), [Tampermonkey](https://www.tampermonkey.net/), etc).
2. Make sure to enable user scripts in extension settings.
3. [Install](https://github.com/thlgr/WAQoL/raw/refs/heads/main/waqol.user.js)

The script has some fallbacks in case WhatsApp Web updates, but in case the patches starts failing open an issue.