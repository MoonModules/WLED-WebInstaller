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
   * Build an esp-web-tools manifest for a single board entry.
   * Each manifest has exactly one build (one chipFamily).
   */
  function generateBoardManifest(version, boardEntry) {
    var config = CHIP_CONFIG[boardEntry.chipFamily];
    if (!config) return null;

    var parts = config.bootParts.map(function (bp) {
      return { path: bp.path, offset: bp.offset };
    });

    parts.push({
      path: CORS_PROXY + boardEntry.downloadUrl,
      offset: config.firmwareOffset
    });

    return {
      name: 'WLED-MM',
      version: version + ' (' + humanizeBoardName(boardEntry.board) + ')',
      home_assistant_domain: 'wled',
      new_install_prompt_erase: true,
      builds: [{ chipFamily: config.chipFamily, parts: parts }]
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
   * Create a single <option> element for a release.  The full board list is
   * stored as a JSON string in data-boards so the board dropdown can be
   * populated when this version is selected.
   */
  function createOption(release) {
    var boards = extractBoards(release);
    if (boards.length === 0) return null;

    var opt = document.createElement('option');
    opt.textContent = getDisplayVersion(release);
    opt.dataset.dynamic = 'true';
    opt.dataset.version = getManifestVersion(release, 'normal');
    opt.dataset.boards = JSON.stringify(boards);
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
