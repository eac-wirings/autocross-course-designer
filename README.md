# Autocross Course Designer

A free, open-source desktop app for designing SCCA-style autocross (Solo) courses.
It runs on Windows, macOS and Linux, needs no account or subscription, and does not upload your data anywhere.

## Features

- **Site map.** Free aerial imagery (Esri World Imagery, or USGS public-domain imagery in the US). You can also import a Google Earth Pro screenshot and set its scale with two clicks, or import placemarks traced in Google Earth (KML/KMZ).
- **Site features.** Mark the paved area, light poles and trees, curbs, buildings and fences, surface hazards (holes, grates, gravel), spectator areas, paddock, grid, and worker stations.
- **Course tools.** Driving line, standing cones, pointer cones, gates, slaloms with set spacing, cone walls, start and finish timing lines, and a measuring tool. Includes undo/redo.
- **Live safety and rules check**, based on the SCCA Solo Rules and the Solo Course Designer training:
  - 25 ft from the course to solid objects (50 ft when karts run, except curbs)
  - 75 ft to spectator, paddock and grid areas
  - The course stays on the pavement and avoids surface hazards
  - Top speed estimate (fast Street cars should not normally go past the mid 60s mph) and flags for long acceleration zones
  - Slalom spacing (45 ft minimum, 60–75 ft recommended) and gate width (15 ft)
  - Finish runout length, and whether the finish points at people
  - Separation between adjacent sections (75 ft when more than one car is on course)
  - Worker coverage, very tight turnarounds, and the balance of left and right turns
  - Wet-weather mode
- **Auto-generate.** Builds a mixed course inside the paved area with rule margins applied. It simulates and checks many candidates and keeps the best one.
- **3D run-through.** Drives the simulated line in driver, chase or free-orbit view, with the aerial photo as the ground.
- **Export.** Save as an `.axcourse` project file, export KML for Google Earth, or export a printable SVG course map with a scale bar.

The speeds come from a simple point-mass simulation, so treat them as estimates. The checker helps with the course walk-through by the Event Chair and Safety Steward; it does not replace it.

## Build

You need Node 20+ and Rust (stable). On Linux you also need the [Tauri system packages](https://v2.tauri.app/start/prerequisites/).

```sh
npm install
npm run app:dev     # run the desktop app in development mode
npm run app:build   # build installers into src-tauri/target/release/bundle
```

`npm run build && npx vite preview` runs the same app in a browser.

## Imagery credits

Esri World Imagery: © Esri, Maxar, Earthstar Geographics, and the GIS User Community. USGS The National Map imagery is in the public domain. Map data © OpenStreetMap contributors. Place search uses OpenStreetMap Nominatim.

## License

MIT