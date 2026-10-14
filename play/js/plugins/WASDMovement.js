//=============================================================================
// WASDMovement.js
//=============================================================================

/*:
 * @plugindesc WASD moves the player and cursors, like the arrow keys. Q / E switch pages.
 *
 * @help
 * W A S D work the same as the arrow keys: walking on the map and moving
 * the cursor in menus, battles and choices. Arrow keys and numpad still work.
 *
 * MV normally uses W as "page down" (next actor in the status / equip /
 * skill menus). W is now "up", so page down moves to E:
 *   Q = previous page    E = next page
 *
 * It also stops the space bar from scrolling the web page when the game is
 * embedded in a page (itch.io, the website), so space just means OK.
 */

(function() {

    Input.keyMapper[87] = 'up';       // W
    Input.keyMapper[65] = 'left';     // A
    Input.keyMapper[83] = 'down';     // S
    Input.keyMapper[68] = 'right';    // D
    Input.keyMapper[69] = 'pagedown'; // E

    var _Input_shouldPreventDefault = Input._shouldPreventDefault;
    Input._shouldPreventDefault = function(keyCode) {
        return keyCode === 32 || _Input_shouldPreventDefault.call(this, keyCode);
    };

})();
