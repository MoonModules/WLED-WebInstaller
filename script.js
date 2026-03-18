/**
 * Populate the board dropdown based on the currently selected version.
 * The version <option> stores available boards in data-boards (JSON).
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

    var boards;
    try {
        boards = JSON.parse(boardsJson);
    } catch (e) {
        return;
    }

    if (!boards || boards.length === 0) return;

    // Group boards by chip family for <optgroup>
    var chipOrder = ['ESP32', 'ESP32-C3', 'ESP32-S2', 'ESP32-S3', 'ESP8266'];
    var groups = {};
    boards.forEach(function (b) {
        if (!groups[b.chipFamily]) groups[b.chipFamily] = [];
        groups[b.chipFamily].push(b);
    });

    var helpers = window._wledMM || {};
    var humanize = helpers.humanizeBoardName || function(s) { return s; };

    chipOrder.forEach(function (chip) {
        if (!groups[chip] || groups[chip].length === 0) return;
        var grp = document.createElement('optgroup');
        grp.label = chip;
        groups[chip].forEach(function (b) {
            var o = document.createElement('option');
            o.textContent = humanize(b.board);
            o.value = JSON.stringify(b);
            boardSel.appendChild(o);
            grp.appendChild(o);
        });
        boardSel.appendChild(grp);
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