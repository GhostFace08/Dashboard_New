VENDOR PACKAGE — drop this whole "vendor" folder into frontend/, so the
final path is: frontend/vendor/...

This replaces every external CDN reference currently in the app. Nothing
in here calls out to the internet at runtime.

WHAT'S INSIDE                                    REPLACES (old CDN line)
--------------------------------------------------------------------------
vendor/fonts/fonts.css                           <link href="https://fonts.googleapis.com/css2?family=Inter...">
  fonts/inter/*.woff2                             (Inter, weights 400/500/600/700, Latin)
  fonts/jetbrains-mono/*.woff2                    (JetBrains Mono, weights 400/500/600/700, Latin)

vendor/lucide/lucide.min.js                      <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js">

vendor/jquery/jquery.min.js                      <script src="https://code.jquery.com/jquery-3.7.1.min.js">

vendor/datatables/css/dataTables.dataTables.min.css   <link href="https://cdn.datatables.net/2.0.8/css/dataTables.dataTables.min.css">
vendor/datatables/js/dataTables.min.js                <script src="https://cdn.datatables.net/2.0.8/js/dataTables.min.js">
vendor/datatables/js/dataTables.dataTables.min.js     (styling-integration glue — load AFTER dataTables.min.js)

vendor/chartjs/chart.umd.min.js                  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js">

vendor/d3/d3-selection.min.js                    New — used by the Topology page (force-directed graph)
vendor/d3/d3-force.min.js                          Load order: selection -> force -> drag -> zoom
vendor/d3/d3-drag.min.js
vendor/d3/d3-zoom.min.js

LOAD ORDER NOTES
--------------------------------------------------------------------------
- DataTables: dataTables.min.js MUST load before dataTables.dataTables.min.js
  (the second file is just the styling glue and depends on the first).
- D3: d3-selection.min.js first, then d3-force / d3-drag / d3-zoom can load
  in any order relative to each other, but all after d3-selection.
- jQuery must load before either DataTables file (unchanged from today).

NEXT STEP
--------------------------------------------------------------------------
I have NOT touched any of the actual page HTML/CSS/JS yet — this delivery
is only the vendor assets themselves. The next file will be the updated
shared.css / page <head> blocks that point at these local paths instead
of the CDN URLs, followed by the new sidebar shell.
