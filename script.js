/**
 * Populate the board dropdown based on the currently selected version.
 * The version <option> stores available boards in data-boards (JSON).
 *
 * Each entry has the shape:
 *   { label: "4MB V4 M [ESP32]", builds: [{ chipFamily, board, downloadUrl }] }
 *
 * When experimental flash-size grouping is enabled, an entry may have multiple
 * builds spanning different chip families (and flash sizes).
 */
function populateBoardDropdown() {
    var verSel = document.getElementById('ver');
    var boardSel = document.getElementById('board');
    var opt = verSel.options[verSel.selectedIndex];
    var boardsJson = opt && opt.dataset.boards;

    // Clear existing options
    boardSel.innerHTML = '';

    if (!boardsJson) {
        // Fallback for static options that don't have data-boards
        var fallbackOpt = document.createElement('option');
        fallbackOpt.textContent = 'No boards available';
        boardSel.appendChild(fallbackOpt);
        return;
    }

    var entries;
    try {
        entries = JSON.parse(boardsJson);
    } catch (e) {
        return;
    }

    if (!entries || entries.length === 0) return;

    entries.forEach(function (entry) {
        var o = document.createElement('option');
        o.textContent = entry.label;
        o.value = JSON.stringify(entry);
        boardSel.appendChild(o);
    });

    // Auto-select the first board
    boardSel.selectedIndex = 0;
}

/**
 * Generate and set the manifest for the currently selected version + board.
 */
function updateManifest() {
    var verSel = document.getElementById('ver');
    var boardSel = document.getElementById('board');
    var verOpt = verSel.options[verSel.selectedIndex];
    var boardOpt = boardSel.options[boardSel.selectedIndex];

    if (!verOpt || !boardOpt || !boardOpt.value) return;

    var helpers = window._wledMM || {};
    var version = verOpt.dataset.version || verOpt.textContent;

    var boardEntry;
    try {
        boardEntry = JSON.parse(boardOpt.value);
    } catch (e) {
        return;
    }

    if (helpers.generateBoardManifest && helpers.createManifestUrl) {
        var manifest = helpers.generateBoardManifest(version, boardEntry);
        if (manifest) {
            var url = helpers.createManifestUrl(manifest);
            document.getElementById('inst').setAttribute('manifest', url);
        }
    }

    document.getElementById('verstr').textContent = verOpt.textContent;
}

/**
 * Called when the version dropdown changes.
 */
function setManifest() {
    populateBoardDropdown();
    updateManifest();
}


function checkSupported() {
    if (document.getElementById('inst').hasAttribute('install-unsupported')) unsupported();
    else setManifest();
}


function unsupported() {
    document.getElementById('flasher').hidden = true;
    document.getElementById('unsupported').hidden = false;
}


function showSerialHelp() {
    document.getElementById('showSerialHelp').hidden = true;
    document.getElementById('serialHelp').hidden = false;
}