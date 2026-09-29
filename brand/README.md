# brand

Images for skech's accounts, made from the landing's own illustrations, mark and font.

| File | Size | For |
|---|---|---|
| `x/x-banner-1500x500.png` | 1500×500 | the X header. `x-banner-3000x1000.png` is the same at 2× |
| `x/x-avatar-mark-400.png` | 400×400 | the X profile photo: the mark, white on brand blue. `-1000` at 1000×1000 |
| `x/x-avatar-pen-400.png` | 400×400 | the other profile photo: the pen on cream, on brand blue |

The banner's words sit high and left: X lays the profile photo over the bottom left (its top at about
67% of the banner's height) and crops the top and bottom on some phones.

## Making them again

`x/source/` has the HTML each is a screenshot of. It reads the illustrations and the font from
`ui/landing` and `ui/app`, so run from the repo root:

```bash
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$C" --headless=new --hide-scrollbars --allow-file-access-from-files --force-device-scale-factor=2 \
  --window-size=1500,500 --screenshot=brand/x/x-banner-3000x1000.png "file://$PWD/brand/x/source/banner.html"
"$C" --headless=new --hide-scrollbars --allow-file-access-from-files --force-device-scale-factor=2 \
  --window-size=500,500 --screenshot=brand/x/x-avatar-mark-1000.png "file://$PWD/brand/x/source/avatar-mark.html"
```

and scale down for the 1500×500 and 400×400 copies.
