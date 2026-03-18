// releases.js - Dynamic release loading from GitHub API for WLED-MM Web Installer
//
// Fetches available WLED-MM releases from the GitHub Releases API and dynamically
// populates the version dropdown. Each release's firmware assets are parsed to
// extract board descriptors (e.g. "esp32_4MB_V4_M"), which are stored as JSON
// on the <option> element. When a version is selected, script.js populates a
// second "board" dropdown and generates an esp-web-tools manifest on-the-fly
// as a blob URL for the selected board.
//
// Falls back to the static <option> elements already in index.htm if the API
// request fails (e.g. rate-limited, offline, network error).

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  const GITHUB_RELEASES_URL = 'https://api.github.com/repos/MoonModules/WLED-MM/releases';
  const CORS_PROXY = 'https://proxy.corsfix.com/?';
  const CACHE_KEY = 'wled_releases_cache';
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  const MAX_STABLE_RELEASES = 8;   // limit dropdown length
  const MAX_BETA_RELEASES = 2;    // only show the two most recent beta releases

  // Experimental: group firmware entries that differ only in flash size / chip
  // into a single dropdown entry with a multi-build manifest.  Requires
  // esp-web-tools with flash-size-aware build selection (see PR #690).
  // Set to true to test with a build of esp-web-tools that includes PR #690.
  const USE_EXPERIMENTAL_FLASH_GROUPING = true;

  // Named / branded board prefixes — these are unique hardware targets and
  // should never be merged with generic ESP builds.
  const NAMED_PREFIXES = [
    'athom', 'wemos', 'abc_', 'adafruit', 'seeed', 'matrixportal'
  ];

  // First segment after the chip prefix that signals the start of the
  // "config" portion of a board descriptor (flash size, features, etc.).
  const CONFIG_START_RE = /^(\d|PSRAM|WROOM|compat)/i;

  // Base URL for locally-hosted bootloader / partition-table files.
  // These are chip-specific and shared across WLED versions.
  const bootBase = new URL('bin/boot/', window.location.href).href;

  // ---------------------------------------------------------------------------
  // Bootloader / partition configuration per chip family
  // ---------------------------------------------------------------------------
  // Each entry describes the boot-stage parts that must be flashed before the
  // WLED firmware binary. The firmware is always the last part.

  const CHIP_CONFIG = {
    'ESP32': {
      chipFamily: 'ESP32',
      bootParts: [
        { path: bootBase + 'esp32_bootloader_v4.bin', offset: 0 }
      ],
      firmwareOffset: 65536
    },
    'ESP32-C3': {
      chipFamily: 'ESP32-C3',
      bootParts: [
        { path: bootBase + 'esp32-c3_bootloader_v2.bin', offset: 0 }
      ],
      firmwareOffset: 65536
    },
    'ESP32-S2': {
      chipFamily: 'ESP32-S2',
      bootParts: [
        { path: bootBase + 'bootloader_s2.bin', offset: 4096 },
        { path: bootBase + 'partitions_s2_4m.bin', offset: 32768 }
      ],
      firmwareOffset: 65536
    },
    'ESP32-S3': {
      chipFamily: 'ESP32-S3',
      bootParts: [
        { path: bootBase + 'bootloader_s3.bin', offset: 0 },
        { path: bootBase + 'partitions_s3_8m.bin', offset: 32768 }
      ],
      firmwareOffset: 65536
    },
    'ESP8266': {
      chipFamily: 'ESP8266',
      bootParts: [],
      firmwareOffset: 0
    }
  };

  // ---------------------------------------------------------------------------
  // Board descriptor → chip family inference
  // ---------------------------------------------------------------------------
  // WLED-MM assets encode board, flash size, PSRAM, and build variant all in
  // one descriptor string. We infer the ESP chip family from the descriptor so
  // the correct bootloader parts are included in the manifest.

  /** Infer the esp-web-tools chipFamily from a WLED-MM board descriptor. */
  function inferChipFamily(board) {
    var b = board.toLowerCase();
    if (/esp32s3|esp32_s3|matrixportal/.test(b)) return 'ESP32-S3';
    if (/esp32s2|esp32_s2/.test(b))              return 'ESP32-S2';
    if (/esp32c3/.test(b))                       return 'ESP32-C3';
    if (/esp8266|esp01/.test(b))                  return 'ESP8266';
    // Everything else (including boards like athom_music_esp32, wemos_shield_esp32, abc_wled_controller)
    return 'ESP32';
  }

  /**
   * Turn a board descriptor into a user-friendly display name.
   * e.g. "esp32_4MB_V4_M" → "ESP32 4MB V4 M"
   *      "athom_music_esp32_4MB_M" → "Athom Music ESP32 4MB M"
   */
  function humanizeBoardName(board) {
    return board
      .replace(/_/g, ' ')
      .replace(/\besp32s3\b/gi, 'ESP32-S3')
      .replace(/\besp32s2\b/gi, 'ESP32-S2')
      .replace(/\besp32c3\b/gi, 'ESP32-C3')
      .replace(/\besp8266\b/gi, 'ESP8266')
      .replace(/\besp32\b/gi, 'ESP32')
      .replace(/\besp01\b/gi, 'ESP-01')
      .replace(/\b(\d+)mb\b/gi, function(_, n) { return n + 'MB'; })
      .replace(/\bpsram\b/gi, 'PSRAM')
      .replace(/\bhub75\b/gi, 'HUB75')
      .replace(/\bopi\b/gi, 'OPI')
      .replace(/\bqspi\b/gi, 'QSPI');
  }

  // ---------------------------------------------------------------------------
  // Board-descriptor splitting & grouping (experimental flash-size grouping)
  // ---------------------------------------------------------------------------

  /**
   * Split a board descriptor into (boardPrefix, configKey, chipFamily, isNamed).
   *
   * boardPrefix includes the chip sub-board identifier so that different
   * hardware variants of the same chip stay separate:
   *   "esp32c3dev"  vs "esp32c3mini_dio"
   *   "esp8266"     vs "esp8266pro"
   *   "esp32"       vs "esp32_pico"
   *
   * configKey is the flash-size + features portion:
   *   "esp32_4MB_V4_M"        → prefix="esp32",     configKey="4MB_V4_M"
   *   "esp32c3dev_2MB_M"      → prefix="esp32c3dev", configKey="2MB_M"
   *   "esp32S3_8MB_PSRAM_M"   → prefix="esp32S3",    configKey="8MB_PSRAM_M"
   *
   * Named boards (athom, wemos, etc.) stay whole and are never grouped.
   */
  function splitBoard(board) {
    var bl = board.toLowerCase();

    // Named / branded boards: keep full name, never group
    for (var i = 0; i < NAMED_PREFIXES.length; i++) {
      if (bl.indexOf(NAMED_PREFIXES[i]) === 0) {
        return { boardPrefix: board, configKey: board, chipFamily: inferChipFamily(board), isNamed: true };
      }
    }

    // Split on underscores and find where the "config" part starts
    var parts = board.split('_');
    var configStart = parts.length; // default: nothing is config
    for (var j = 1; j < parts.length; j++) { // skip first segment (always chip)
      if (CONFIG_START_RE.test(parts[j])) {
        configStart = j;
        break;
      }
    }

    if (configStart === 0 || configStart >= parts.length) {
      // Can't split meaningfully — treat as named / unique
      return { boardPrefix: board, configKey: board, chipFamily: inferChipFamily(board), isNamed: true };
    }

    var prefix = parts.slice(0, configStart).join('_');
    var config = parts.slice(configStart).join('_');
    return { boardPrefix: prefix, configKey: config, chipFamily: inferChipFamily(prefix), isNamed: false };
  }

  /**
   * Strip the flash-size segment from a config key to produce a
   * "flash-agnostic" grouping key.
   *
   * Examples:
   *   "4MB_V4_M"       → "V4_M"
   *   "16MB_V4_M"      → "V4_M"
   *   "4MB_PSRAM_S"    → "PSRAM_S"
   *   "PSRAM_M"        → "PSRAM_M"   (no flash size present)
   *   "WROOM-2_M"      → "WROOM-2_M" (no flash size present)
   *   "compat"         → "compat"
   */
  function stripFlashSize(configKey) {
    return configKey.replace(/^\d+MB_/i, '');
  }

  /**
   * Build a human-readable label for a grouped dropdown entry.
   *
   * @param {string}   faConfig      - the flash-agnostic config, e.g. "V4_M"
   * @param {string[]} chipFamilies  - unique chip families in the group
   * @param {string[]} flashSizes    - unique flash sizes in the group (may be empty)
   * @returns {string} e.g. "V4 M (4MB/16MB) [ESP32, ESP32-S3]"
   */
  function buildGroupLabel(faConfig, chipFamilies, flashSizes) {
    var base;

    // Flash sizes
    if (flashSizes.length > 1) {
      flashSizes.sort(function (a, b) { return parseInt(a) - parseInt(b); });
      base = humanizeBoardName(faConfig) + ' (' + flashSizes.join('/') + ')';
    } else if (flashSizes.length === 1) {
      base = humanizeBoardName(flashSizes[0] + '_' + faConfig);
    } else {
      base = humanizeBoardName(faConfig);
    }

    // Chip list
    if (chipFamilies.length > 0) {
      base += ' [' + chipFamilies.join(', ') + ']';
    }

    return base;
  }

  /**
   * Group an array of board entries by flash-agnostic config key across ALL
   * chip families, so that e.g. "esp32_4MB_M", "esp32s2_4MB_M", and
   * "esp8266_4MB_M" become one dropdown entry "M (2MB/4MB/16MB) [ESP32-C3,
   * ESP32-S2, ESP8266]".
   *
   * Collision handling: if two entries in a bucket share the SAME chipFamily
   * AND the SAME flashSize (e.g. esp32c3dev_4MB_M and esp32c3mini_dio_4MB_M),
   * those specific entries are split out as individual dropdown items because
   * esp-web-tools cannot distinguish between them. The remaining non-colliding
   * entries are still grouped.
   *
   * @param {Array} boardEntries - from extractBoards()
   * @returns {Array} grouped entries, each with shape:
   *   { label, builds: [{ chipFamily, board, downloadUrl }] }
   */
  function groupBoards(boardEntries) {
    // Step 1: split each board and compute flash-agnostic config key
    var parsed = boardEntries.map(function (entry) {
      var split = splitBoard(entry.board);
      var flashMatch = split.isNamed ? null : split.configKey.match(/^(\d+MB)/i);
      return {
        board: entry.board,
        chipFamily: entry.chipFamily,
        downloadUrl: entry.downloadUrl,
        boardPrefix: split.boardPrefix,
        configKey: split.configKey,
        isNamed: split.isNamed,
        faConfig: split.isNamed ? null : stripFlashSize(split.configKey),
        // Group key: just the flash-agnostic config (cross-chip grouping)
        groupKey: split.isNamed ? entry.board : stripFlashSize(split.configKey),
        flashSize: flashMatch ? flashMatch[1] : null
      };
    });

    // Step 2: bucket by groupKey (flash-agnostic config only)
    var buckets = {};
    var bucketOrder = [];
    parsed.forEach(function (p) {
      if (!buckets[p.groupKey]) {
        buckets[p.groupKey] = [];
        bucketOrder.push(p.groupKey);
      }
      buckets[p.groupKey].push(p);
    });

    // Step 3: for each bucket, detect (chipFamily, flashSize) collisions
    // and split colliders out as individual entries
    var result = [];
    bucketOrder.forEach(function (key) {
      var entries = buckets[key];
      var label;

      // Find collisions: same (chipFamily, flashSize) with different sub-boards
      var slotMap = {};  // "chip|flash" -> [entries]
      entries.forEach(function (e) {
        var slot = e.chipFamily + '|' + (e.flashSize || '');
        if (!slotMap[slot]) slotMap[slot] = [];
        slotMap[slot].push(e);
      });

      var colliders = {};
      Object.keys(slotMap).forEach(function (slot) {
        if (slotMap[slot].length > 1) {
          slotMap[slot].forEach(function (e) {
            colliders[e.board] = true;
          });
        }
      });

      // Non-colliders get grouped; colliders become individual entries
      var grouped = entries.filter(function (e) { return !colliders[e.board]; });
      var individual = entries.filter(function (e) { return !!colliders[e.board]; });

      if (grouped.length > 0) {
        var chips = [];
        var flashSizes = [];
        var chipSeen = {};
        var builds = grouped.map(function (e) {
          if (!chipSeen[e.chipFamily]) {
            chipSeen[e.chipFamily] = true;
            chips.push(e.chipFamily);
          }
          if (e.flashSize && flashSizes.indexOf(e.flashSize) === -1) {
            flashSizes.push(e.flashSize);
          }
          return {
            chipFamily: e.chipFamily,
            board: e.board,
            downloadUrl: e.downloadUrl
          };
        });

        if (grouped.length === 1) {
          // Single entry — show prefix + config in label
          var e = grouped[0];
          if (e.isNamed) {
            label = humanizeBoardName(e.board);
          } else {
            label = humanizeBoardName(e.boardPrefix) + ' ' + humanizeBoardName(e.configKey);
          }
        } else {
          label = buildGroupLabel(grouped[0].faConfig, chips, flashSizes);
        }
        result.push({ label: label, builds: builds });
      }

      // Emit colliders individually
      individual.forEach(function (e) {
        label = humanizeBoardName(e.board) + ' [' + e.chipFamily + ']';
        result.push({
          label: label,
          builds: [{
            chipFamily: e.chipFamily,
            board: e.board,
            downloadUrl: e.downloadUrl
          }]
        });
      });
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract board descriptors from a release's asset list.
   * Returns an array of { board, chipFamily, downloadUrl } objects.
   *
   * Naming patterns:
   *   Release: WLEDMM_<version>_<board>.bin
   *   Nightly: firmware-<board>.bin
   */
  function extractBoards(release) {
    var isNightly = (release.tag_name === 'nightly');
    var boards = [];
    var seen = {};

    release.assets.forEach(function (asset) {
      if (asset.name.endsWith('.gz')) return;
      var m;
      if (isNightly) {
        m = asset.name.match(/^firmware-(.+)\.bin$/);
      } else {
        m = asset.name.match(/^WLEDMM_.+?_(.+)\.bin$/);
      }
      if (!m) return;

      var board = m[1];
      if (seen[board]) return;
      seen[board] = true;

      boards.push({
        board: board,
        chipFamily: inferChipFamily(board),
        downloadUrl: asset.browser_download_url
      });
    });

    // Sort: by chip family first, then alphabetically by board name
    var chipOrder = { 'ESP32': 0, 'ESP32-C3': 1, 'ESP32-S2': 2, 'ESP32-S3': 3, 'ESP8266': 4 };
    boards.sort(function (a, b) {
      var ca = chipOrder[a.chipFamily] || 99;
      var cb = chipOrder[b.chipFamily] || 99;
      if (ca !== cb) return ca - cb;
      return a.board.localeCompare(b.board);
    });

    return boards;
  }

  /** Extract the WLED version string from asset filenames (for nightly). */
  function extractVersionFromAssets(assets) {
    for (var i = 0; i < assets.length; i++) {
      // Try release naming first
      var m = assets[i].name.match(/^WLEDMM_(.+?)_/);
      if (m) return m[1];
      // Try nightly naming — version is in the tag, not the filename
    }
    return 'unknown';
  }

  /** Human-readable version for the dropdown. */
  function getDisplayVersion(release) {
    if (release.tag_name === 'nightly') {
      return extractVersionFromAssets(release.assets) + ' Nightly';
    }
    return release.tag_name.replace(/^v/, '');
  }

  /** Version string embedded in the manifest JSON. */
  function getManifestVersion(release, variantName) {
    let ver;
    if (release.tag_name === 'nightly') {
      ver = extractVersionFromAssets(release.assets);
    } else {
      ver = release.tag_name.replace(/^v/, '');
    }
    if (variantName !== 'normal') {
      ver += ' ' + variantName;
    }
    return ver;
  }

  // ---------------------------------------------------------------------------
  // Manifest generation
  // ---------------------------------------------------------------------------

  /**
   * Build an esp-web-tools manifest for a board entry.
   *
   * Supports two shapes of boardEntry:
   *
   * 1. Single board (default mode):
   *    { chipFamily, board, downloadUrl }
   *    → manifest with one build
   *
   * 2. Grouped entry (experimental flash-size grouping):
   *    { label, builds: [{ chipFamily, board, downloadUrl }, ...] }
   *    → manifest with multiple builds (esp-web-tools selects by chip + flash)
   */
  function generateBoardManifest(version, boardEntry) {
    // Detect grouped vs single entry
    var buildSources = boardEntry.builds || [boardEntry];
    var builds = [];

    for (var i = 0; i < buildSources.length; i++) {
      var src = buildSources[i];
      var config = CHIP_CONFIG[src.chipFamily];
      if (!config) continue;

      var parts = config.bootParts.map(function (bp) {
        return { path: bp.path, offset: bp.offset };
      });

      parts.push({
        path: CORS_PROXY + src.downloadUrl,
        offset: config.firmwareOffset
      });

      builds.push({ chipFamily: config.chipFamily, parts: parts });
    }

    if (builds.length === 0) return null;

    var displayName = boardEntry.label
      ? boardEntry.label
      : humanizeBoardName(boardEntry.board);

    return {
      name: 'WLED-MM',
      version: version + ' (' + displayName + ')',
      home_assistant_domain: 'wled',
      new_install_prompt_erase: true,
      builds: builds
    };
  }

  /** Create a blob:// URL from a manifest object so esp-web-tools can fetch it. */
  function createManifestUrl(manifest) {
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
    return URL.createObjectURL(blob);
  }

  // ---------------------------------------------------------------------------
  // Dropdown population
  // ---------------------------------------------------------------------------

  function categorize(release) {
    if (release.tag_name === 'nightly') return 'nightly';
    if (release.prerelease) return 'beta';
    return 'release';
  }

  /**
   * Create a single <option> element for a release.  The board list is
   * stored as a JSON string in data-boards so the board dropdown can be
   * populated when this version is selected.
   *
   * When USE_EXPERIMENTAL_FLASH_GROUPING is enabled, boards are grouped by
   * flash-agnostic config key so that e.g. 4MB_M and 16MB_M become one
   * dropdown entry with a multi-build manifest.
   */
  function createOption(release) {
    var boards = extractBoards(release);
    if (boards.length === 0) return null;

    var entries;
    if (USE_EXPERIMENTAL_FLASH_GROUPING) {
      entries = groupBoards(boards);
    } else {
      // Default: each board is its own entry (single-build manifests)
      entries = boards.map(function (b) {
        return {
          label: humanizeBoardName(b.board) + ' [' + b.chipFamily + ']',
          builds: [{ chipFamily: b.chipFamily, board: b.board, downloadUrl: b.downloadUrl }]
        };
      });
    }

    if (entries.length === 0) return null;

    var opt = document.createElement('option');
    opt.textContent = getDisplayVersion(release);
    opt.dataset.dynamic = 'true';
    opt.dataset.version = getManifestVersion(release, 'normal');
    opt.dataset.boards = JSON.stringify(entries);
    return opt;
  }

  /** Replace the <select> contents with dynamically generated options. */
  function populateDropdown(releases) {
    const sel = document.getElementById('ver');

    // Group by category
    const groups = { release: [], beta: [], nightly: [] };
    releases.forEach(function (r) {
      if (r.draft || !r.assets || r.assets.length === 0) return;
      groups[categorize(r)].push(r);
    });

    // Limit the number of stable releases shown
    if (groups.release.length > MAX_STABLE_RELEASES) {
      groups.release = groups.release.slice(0, MAX_STABLE_RELEASES);
    }
    // Limit the number of beta releases shown (only the two most recent)
    if (groups.beta.length > MAX_BETA_RELEASES) {
      groups.beta = groups.beta.slice(0, MAX_BETA_RELEASES);
    }

    // Build option groups
    const fragment = document.createDocumentFragment();

    if (groups.release.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = 'Release';
      groups.release.forEach(function (r) {
        const opt = createOption(r);
        if (opt) grp.appendChild(opt);
      });
      if (grp.children.length > 0) fragment.appendChild(grp);
    }

    if (groups.beta.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = 'Beta';
      groups.beta.forEach(function (r) {
        const opt = createOption(r);
        if (opt) grp.appendChild(opt);
      });
      if (grp.children.length > 0) fragment.appendChild(grp);
    }

    if (groups.nightly.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = 'Nightly';
      groups.nightly.forEach(function (r) {
        const opt = createOption(r);
        if (opt) grp.appendChild(opt);
      });
      if (grp.children.length > 0) fragment.appendChild(grp);
    }

    // Only replace contents if we actually produced options
    if (fragment.children.length > 0) {
      sel.innerHTML = '';
      sel.appendChild(fragment);
    }
  }

  // ---------------------------------------------------------------------------
  // Caching (sessionStorage, 5-minute TTL)
  // ---------------------------------------------------------------------------

  function getCachedReleases() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (Date.now() - data.timestamp < CACHE_TTL) return data.releases;
    } catch (e) {
      console.warn('Failed to read releases cache:', e);
    }
    return null;
  }

  function cacheReleases(releases) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        timestamp: Date.now(),
        releases: releases
      }));
    } catch (e) {
      console.warn('Failed to write releases cache:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------

  /**
   * Safely call populateBoardDropdown() and updateManifest() from script.js.
   * These are defined in script.js which loads before releases.js, but we add
   * defensive checks for robustness.
   */
  function applySelection() {
    if (typeof populateBoardDropdown === 'function') populateBoardDropdown();
    if (typeof updateManifest === 'function') updateManifest();
  }

  // Expose manifest helpers so script.js can generate manifests on board change
  window._wledMM = {
    generateBoardManifest: generateBoardManifest,
    createManifestUrl: createManifestUrl,
    humanizeBoardName: humanizeBoardName
  };

  /**
   * Fetch releases and populate the dropdown.  On failure the existing static
   * <option> elements in the HTML remain untouched, so the installer still
   * works (just with the hardcoded version list).
   */
  window.loadReleases = function loadReleases() {
    const cached = getCachedReleases();
    if (cached) {
      populateDropdown(cached);
      applySelection();
      return;
    }

    fetch(GITHUB_RELEASES_URL + '?per_page=30')
      .then(function (res) {
        if (!res.ok) throw new Error('GitHub API responded with ' + res.status);
        return res.json();
      })
      .then(function (releases) {
        cacheReleases(releases);
        populateDropdown(releases);
        applySelection();
      })
      .catch(function (err) {
        console.warn('Failed to load releases from GitHub API – using static fallback.', err);
        // Static options remain in place; setManifest() was already called
        // by checkSupported() during page load, so no action needed.
      });
  };
})();
