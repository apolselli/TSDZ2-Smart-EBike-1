# TSDZ2 Web Configurator

A browser-based port of `JavaConfigurator.jar` (the Swing `TSDZ2_Configurator.java`),
as a single HTML page plus a tiny local Node.js server. Zero npm dependencies.

- **Everything runs client-side** in `public/index.html`: the full UI (3 tabs, same
  groups/fields as the Java app), all cross-field validation and conversions, and the
  generation of `settings.ini`, `src/config.h` and the TSDZ8 `TSDZ8_config.hex`.
- **The Node server only compiles**: it receives the generated files, queues a
  firmware build (`make` + SDCC) in an isolated copy of `src/`, and serves the
  resulting hex for download. Flashing is out of scope - use
  `stm8flash -c stlinkv2 -p stm8s105?6 -w <hex>` or `compile_and_flash_20.sh` yourself.

## Run

```sh
cd src/web-configurator
node server.js          # http://127.0.0.1:3000  (PORT/HOST env to change)
```

Requirements for compilation only: `sdcc` (STM8 target) and `make` in PATH.

## Compile flow

1. Click **Compile firmware** - the page generates the `.ini` + `config.h`,
   saves a timestamped copy of the settings into the browser's experimental list,
   and POSTs them to the server, which assigns a build GUID.
2. You are redirected to a waiting page (`/compile/<guid>`) that shows the live
   build log and your position in the queue (builds run one at a time).
3. When the build finishes, download `TSDZ2-<version>-<settings>.hex`,
   `config.h`, the `settings.ini` or the build log from that page.

With motor type **TSDZ8** selected, no server build happens: the button generates
`TSDZ8_config.hex` in the browser and downloads it immediately (same as the Java app).

## Settings files

- The repository defaults (`proven settings/*.ini`) are listed under
  *Proven Settings* (read-only, served by the local server).
- Your own saves live in the browser (localStorage) in the same
  experimental/proven structure, with the *Copy from Experimental to Proven*
  button working like the Java app.
- *Import .ini* / *Export .ini* move files between disk and the browser.

## Build artifacts

Each build gets its own folder `src/web-configurator/builds/<guid>/` containing a
copy of the firmware sources (the `web-configurator` folder itself is excluded),
the used `config.h`, `settings.ini`, `build.log` and the hex.
The newest 20 builds are kept.

## Parity with the Java tool

The `.ini` and `config.h` output are byte-compatible with the Java configurator
(field ids in the source are the original Swing variable names). Integer math
(truncating division, `(int)(float*100)`) mirrors Java semantics so generated
files are identical for identical inputs.
