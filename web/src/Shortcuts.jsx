// Shortcuts sheet: every keyboard binding on one card. Static content; the
// actual bindings live in App.jsx's keydown handler, and the footer hints
// mirror the most common ones.
export default function Shortcuts({ onClose }) {
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet shortcuts">
        <h3>Keyboard</h3>
        <p className="hint">
          Escape closes any panel. Tab reaches the sidebar, search, and buttons.
        </p>
        <h3>Move and act</h3>
        <ul className="keys">
          <li>
            <kbd>h</kbd> <kbd>j</kbd> <kbd>k</kbd> <kbd>l</kbd> move in the grid; while reading an
            article, <kbd>j</kbd>/<kbd>k</kbd> step to the next or previous one
          </li>
          <li>
            <kbd>h</kbd> at the left edge jumps to the sidebar; <kbd>l</kbd> or{' '}
            <kbd>Escape</kbd> returns to the grid
          </li>
          <li>
            <kbd>g</kbd> <kbd>g</kbd> top of the list · <kbd>G</kbd> bottom of what's loaded
          </li>
          <li>
            <kbd>Enter</kbd> or <kbd>o</kbd> open · <kbd>Escape</kbd> close
          </li>
          <li>
            <kbd>m</kbd> read toggle · <kbd>s</kbd> star · <kbd>u</kbd> unread-only filter
          </li>
          <li>
            <kbd>M</kbd> mark everything in the current view read (asks first)
          </li>
          <li>
            <kbd>r</kbd> fetch all feeds now
          </li>
        </ul>
        <h3>Search and panels</h3>
        <ul className="keys">
          <li>
            <kbd>/</kbd> search · <kbd>Escape</kbd> clears it
          </li>
          <li>
            <kbd>,</kbd> settings
          </li>
          <li>
            <kbd>?</kbd> this card
          </li>
        </ul>
      </div>
    </div>
  )
}
