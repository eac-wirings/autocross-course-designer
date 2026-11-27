# Autocross Course Designer

A free, open-source desktop app for designing SCCA-style autocross (Solo) courses.
It runs on Windows, macOS and Linux, needs no account or subscription, and does not upload your data anywhere.

## Features

- **Site map.** Free aerial imagery (Esri World Imagery, or USGS public-domain imagery in the US). You can also import a Google Earth Pro screenshot and set its scale with two clicks, or import placemarks traced in Google Earth (KML/KMZ).
- **Find pavement (magic wand).** Click inside a parking lot or runway and the app outlines it from the aerial photo, offline and with no API key. Grass infields become Don't-use zones. Shift-click to add more areas, and use the Tolerance slider to grow or shrink the result.
- **Shape editing.** Fix outlines without moving points one by one. **Cut away**: draw a shape to remove part of a zone (straight-edged cuts, splits, or holes). **Add area**: draw a shape to merge in. **Straighten**: click two corners and everything between becomes one straight edge. **Smooth edges**: a slider that removes wiggles.
- **Zones.** Draw the course area (where the course may go), the paddock, and don't-use areas, plus the grid and spectator areas. Draw rectangles with two clicks, or polygons for odd shapes. The checker and generator keep the course inside the course area and out of don't-use zones.
- **Site objects.** Mark light poles and trees, curbs, buildings and fences, surface hazards (holes, grates, gravel), and worker stations.
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
- **Site map and Course modes.** Map zones in Site map mode; in Course mode zones can't be clicked, so cones are easy to grab.
- **Auto-generate cones.** Place the start and finish, draw the path you want, and it places gates, apex pointers, slaloms or offsets on long straights, the finish chute and a slow-down gate along it, keeping every cone on usable pavement. It can also design the whole path, with or without crossovers.
- **Finish runout on the map.** In Course mode a band past the finish shows the stopping distance needed at your finish speed: green where it's clear, red where it falls short, with what cuts it off.
- **Event facilities.** Timing & scoring, registration, tech, first aid, fire extinguishers, restrooms, impound and emergency access, with the 75 ft people margin applied.
- **Automatic updates.** The app checks for a new version on launch and installs it with one click (Help → Check for updates any time).
- **Apex club sign-in.** Sign in with your club's Apex account (approved in your browser) to link a course map to one of your events; it shows on the event in Apex and on the club website.
- **Community track maps.** Load a site map another club has shared, or share yours (zones, objects and facilities only; never cones).
- **Clear course and zone locks.** Clear course removes cones, the driving line and timing lines but keeps zones. Lock zones so they can't be reshaped, cut or deleted by accident.
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