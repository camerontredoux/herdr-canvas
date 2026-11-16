# herdr-canvas

A freehand drawing board for [Herdr](https://github.com/herdrdev/herdr-app). It opens as a pane in any tab. Every pane shows the same drawing.

## Features

- **Pen:** smoothed strokes that keep their shape. Draw fast to round out curves. Draw slowly for exact lines.
- **Straight lines:** hold the pen still at the end of a stroke for 200 ms. The stroke snaps to a straight line.
- **Eraser:** drag across strokes and text to remove them.
- **Pointer:** select, move, resize, copy, duplicate and delete items.
- **Text:** click to place text and type.
- **Images:** paste an image, or drop an image file on the canvas.
- **Pan and zoom:** scroll with two fingers, drag with the middle button, or hold Space and drag to pan. Pinch or Cmd-scroll to zoom from 10% to 800%.
- **Minimap:** shows the whole drawing and where the view is.
- **Undo and redo:** Cmd-Z and Cmd-Shift-Z.

Tool keys, pressed with no modifier:

| Key | Tool |
|---|---|
| S | Pointer |
| A | Pen |
| E | Eraser |
| T | Text |

Esc goes back to the pointer. The comment at the top of `main.js` lists every shortcut.

## Install

1. Clone this repository into your Herdr mods folder:

   ```sh
   git clone https://github.com/camerontredoux/herdr-canvas ~/.config/herdr-app/mods/canvas
   ```

2. Check that Herdr can load the mod:

   ```sh
   herdr-app check mods/canvas
   ```

3. Open the canvas in a new tab:

   ```sh
   herdr-app do tab.new --name canvas --mod canvas
   ```

   To open it with a key, bind a command that opens the `canvas` mod in your Herdr key config.

## Where the drawing is saved

The canvas saves to Herdr's data folder on your computer. It does not save to this repository.

| File | Contents |
|---|---|
| `data/canvas/drawing.json` | Strokes, text and image references |
| `data/canvas/view.json` | Pan position, zoom, color and pen size |
| `data/canvas/images/` | Pasted and dropped images |

## Development

- `main.js` is the view: tools, input, saving and painting.
- `geometry.js` holds the stroke geometry: smoothing, simplifying, straightening and tracing. It has no Herdr imports, so Node can test it.
- `text.js` moves the caret in a text box: by character, by word and by line. Like `geometry.js`, Node can test it.

Run the tests with Node:

```sh
node test.mjs
```

Herdr writes `gpui-kit.d.ts` and `jsconfig.json` into the mod folder for editor type checking. `.gitignore` leaves them out.

### Performance

Herdr stops a view's `render()` if it runs longer than about 50 ms, and then shows the last frame that worked. The canvas stays under that limit as follows:

- Strokes are drawn in 64 tile views. Herdr keeps a tile's drawing while the tile moves or stretches, so panning repaints no strokes.
- After a zoom, tiles rebuild at the new zoom, one tile per frame, nearest the middle of the screen first.
- Each frame has a time budget for building stroke paths. Work that does not fit waits for the next frame.
