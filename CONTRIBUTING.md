# Contributing to Tab View

## Adding a New Cursor Style

Cursor styles are defined in the `_tvCursorStyles` map at the top of `screen.js`. Each style needs two things: a `css` function that returns the visual properties, and a `position` function that handles placement on the score.

### Structure

```js
styleName: {
    defaultColor: 'rgba(R,G,B,A)',
    css: function (color) {
        var c = color || this.defaultColor;
        return {
            // CSS properties applied to the highlight element
        };
    },
    position: function (cursorRect, wrapRect, scrollLeft, scrollTop) {
        return {
            x: /* horizontal position */,
            y: /* vertical position */,
            width: /* CSS width string */,
            height: /* CSS height string */,
        };
    },
},
```

### `css(color)`

Returns an object of CSS properties that get applied to the highlight element via `Object.assign`. The `color` parameter is either the user's chosen color (as an `rgba()` string) or `null`, in which case you should fall back to `this.defaultColor`.

Properties you'll typically set: `width`, `height`, `background`, `border`, `borderRadius`, `boxShadow`. The base styles (`position:absolute`, `pointer-events:none`, `z-index`, `display`) are already set on the element, so you don't need to include those.

#### Color Format

User-selected colors are converted to `rgba()` strings before being passed to your `css` function. If no custom color is set, `color` will be `null`. Always fall back to `this.defaultColor` in that case.

Note that `defaultColor` should always be set as `rgba(R, G, B, A)` as the plugin requires an alpha value for rendering functions. Setting to `rgb(R, G, B)` or hex (`#RRGGBB`) notation is not supported.

### `position(cursorRect, wrapRect, scrollLeft, scrollTop)`

Returns an object with `x`, `y`, `width`, and `height` that positions the highlight relative to the scrollable container.

| Parameter | Description |
|---|---|
| `cursorRect` | `DOMRect` of the current cursor element from alphaTab |
| `wrapRect` | `DOMRect` of the tab view container |
| `scrollLeft` | Current horizontal scroll offset of the container |
| `scrollTop` | Current vertical scroll offset of the container |

`width` and `height` should be CSS strings (e.g. `'2px'`, `'24px'`). `x` and `y` should be numbers in pixels — they get rounded and set as `left` and `top`.

### Example

Here's the line style for reference (Guitar Pro/Songsterr style):

```js
line: {
    // NOTE: Color is always in rgba(R, G, B, A) format
    // See Color format above
    defaultColor: 'rgba(34,211,238,0.9)',
    css: function (color) {
        var c = color || this.defaultColor;
        return {
            width: '2px',
            height: '100%',
            background: c,
            border: 'none',
            borderRadius: '1px',
            boxShadow: '0 0 6px ' + c + ',0 0 12px ' + c,
        };
    },
    position: function (cursorRect, wrapRect, scrollLeft, scrollTop) {
        return {
            x: cursorRect.left - wrapRect.left + scrollLeft + (cursorRect.width / 2) - 1,
            y: cursorRect.top - wrapRect.top + scrollTop,
            width: '2px',
            height: Math.round(cursorRect.height) + 'px',
        };
    },
},
```

### Registering the Style

To register a new style, simply add your style object to the `_tvCursorStyles` map in `screen.js`. It will be registered in the settings menu as the defined `name` property.
