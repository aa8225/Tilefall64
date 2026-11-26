TILEFALL 64
(c) 2026 AA Software Ltd

An 8-bit tile-catching arcade game for phones, tablets and computers.
It runs in the web browser: no app store, no account, no ads.

=====================================================
 STEP 1 - PUT IT ONLINE ONCE (about 2 minutes, free)
=====================================================
 1. Unzip this file.
 2. On a computer, go to  app.netlify.com/drop
 3. Drag the whole "Tilefall64" folder onto the page.
 4. You get a link like  https://something.netlify.app
    (sign up free to keep it and rename it, e.g. tilefall64-aasoftware)

 Other free options: itch.io (upload the zip as an HTML game)
 or GitHub Pages. Any host works as long as it uses https.

=====================================================
 STEP 2 - GET IT ONTO ANY PHONE
=====================================================
 Open the game and tap SHARE (top right). It shows:
   - a QR code: friends point their phone camera at it
   - COPY LINK / SEND: paste into WhatsApp, text or email
   - INSTALL ON THIS DEVICE

 Installing (makes an app icon, full screen, works offline):
   Android (Chrome): tap INSTALL ON THIS DEVICE, then Install.
   iPhone/iPad (Safari): tap the Share icon, then
                         "Add to Home Screen", then Add.

=====================================================
 WHAT'S IN THIS FOLDER
=====================================================
  index.html            The page that holds the game
  game.js               The game: graphics, music, rules (fully commented)
  styles.css            The look of the page, buttons and share panel
  lib/qrcode.js         QR code generator for the SHARE panel (MIT licence)
  fonts/                Press Start 2P pixel font and its licence (free to use)
  manifest.webmanifest  App name, icon and colours
  sw.js                 Offline play and automatic updates
  icon-*.png            App icons
  logo.png              Tilefall 64 logo for your website or posts
  share.png             Preview picture shown when the link is posted

=====================================================
 HOW TO PLAY
=====================================================
  Tap a lane to move the paddle, tap the same lane again to drop a tile.
  Swipe up (or press TOSS) to throw a tile back up the ramp.
  Line up 3 or more of a colour across, down or diagonally.
  Flashing rainbow tiles are wild: drop one where it completes a line of 3
  and it becomes that colour (counts as one completion). Anywhere else,
  it clears the whole column.
  Waves change: match lines, make diagonals or across lines, lines of 4+,
  reach a score, catch tiles, survive the clock, clear a pre-filled bin,
  and bonus rounds where misses don't cost a life.
  18 scenes, each with its own thought, some change as you play.
  Top 10 scores are saved on each device with your initials.
  Keyboard: arrows move, Space/Down drops, Up tosses, P pauses.
