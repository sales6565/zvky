/* THE STUDIO'S COLOURS, AS A FIXED CATALOGUE OF TOKENS.
 *
 * Every colour the application draws comes from a token in this file. The page's
 * CSS reads each one through a CSS custom property, the saved theme overrides
 * those properties, and with nothing saved the generated CSS is byte-for-byte the
 * palette the application shipped with — so an untouched deployment looks exactly
 * as it did before any of this existed.
 *
 * ---------------------------------------------------------------------------
 * FOUR DECISIONS WORTH READING BEFORE CHANGING ANYTHING HERE.
 *
 * 1. THE CSS PROPERTY NAMES ARE THE ONES THE PAGE ALREADY USED. `surface.page`
 *    writes `--bg`, not `--surface-page`, because `var(--bg)` appears 791 times
 *    across public/index.html and renaming all of them would be a thousand-line
 *    diff in which a real mistake could hide. The token KEY is the stable public
 *    name — it is what the API accepts, what the audit records and what an
 *    exported theme file contains — and `css` is an implementation detail of the
 *    stylesheet. New tokens get names that match their keys.
 *
 *    THE SEVEN SEMANTIC LEGACY NAMES ARE KEPT TOO — --not, --prog, --review,
 *    --approved, --final, --client, --artist-blue. Every one of their 69 uses in
 *    the stylesheet means a MEANING or a CHART SERIES rather than a status badge
 *    (checked, line by line), so they are the palette tokens for those ideas and
 *    the status tokens below are new properties that merely START at the same
 *    values. A studio recolouring In Progress therefore does not also recolour
 *    every warning in the application, which is the distinction the shipped
 *    stylesheet could not express.
 *
 * 2. TRANSLUCENT VARIANTS ARE DERIVED, NOT EDITED. The shipped stylesheet carried
 *    the same semantic colour at a dozen different alphas —
 *    rgba(255,90,54,.08/.09/.12/.15/.16/.30/.32/.45) is all "overdue" — and a
 *    Settings screen with eight rows for one idea is a screen nobody finishes.
 *    So a token may declare `alphas`, and each entry generates a second custom
 *    property holding the SAME colour at that alpha, as eight-digit hex. One row
 *    in Settings; a studio that recolours Overdue gets every tint with it.
 *
 * 3. EIGHT-DIGIT HEX RATHER THAN color-mix(). The page already used color-mix in
 *    three places, always with an rgba line above it as a fallback — so dropping
 *    the literal would have left an old browser with no value at all, which for a
 *    background means transparent. #RRGGBBAA is supported everywhere color-mix is
 *    and about six years further back, and it keeps every default byte-exact.
 *
 * 4. A COLOUR THAT IS NOT A COLOUR TODAY DOES NOT GET A TOKEN. The disabled look
 *    on tabs and buttons is `opacity:.45;filter:grayscale(1)` — there is no
 *    disabled colour in this stylesheet, and inventing one would change how the
 *    application looks, which is the one thing this change must not do. The same
 *    goes for striped table rows (there are none) and for a danger BUTTON
 *    background (danger is a text colour on a ghost button). Reported rather than
 *    filled in.
 */

/* ---------------------------------------------------------------------------
 * VALUE SHAPES.
 *
 * `#RGB` and `#RRGGBB` everywhere; `#RRGGBBAA` only where the token is flagged
 * `alpha`, which is exactly the overlays, the shadows and the two sunk surfaces.
 * Letting alpha through on an ordinary colour is how a studio makes its own text
 * half-transparent and then cannot read the screen to put it back — and the
 * contrast figures this file computes would be measuring something the viewer
 * never sees. Overlays and shadows are translucent BY DEFINITION; refusing alpha
 * there would mean no token could hold what the stylesheet already has.
 */
const SHORT = /^#[0-9a-fA-F]{3}$/;
const SIX = /^#[0-9a-fA-F]{6}$/;
const EIGHT = /^#[0-9a-fA-F]{8}$/;

/* THE WHOLE THEME, AS A SIZE. Thirty characters per token is generous for
   '#RRGGBBAA' plus a key, and the cap is on the REQUEST rather than on the row
   count so a payload of one enormous key is refused before it is parsed. */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PRESETS = 12;
const HISTORY_LIMIT = 20;

/* One token. `css` is the custom property it writes; `alphas` generates derived
   properties at those alphas, named `<css>-<suffix>`. */
const t = (key, css, label, group, def, describe, extra = {}) =>
  ({ key, css, label, group, default: def, describe, ...extra });

const GROUPS = [
  'Navigation tabs', 'Sub-tabs', 'Surfaces', 'Text', 'Buttons', 'Forms',
  'Tables', 'Meaning', 'Workflow statuses', 'Charts and tiles', 'Sign-in',
];

/* ---------------------------------------------------------------------------
 * THE CATALOGUE.
 *
 * Every default below is the value the shipped stylesheet carried at the line
 * named in its description. tests/theme.test.js asserts each one against a
 * recorded list taken from the tree before this change, so a typo here fails
 * rather than quietly repainting the studio.
 */
const TOKENS = [
  // --- Surfaces -------------------------------------------------------------
  t('surface.page', 'bg', 'Page background', 'Surfaces', '#14161B',
    'Behind everything, and the background the board and every panel sit on.'),
  t('surface.panel', 'surface', 'Card and panel background', 'Surfaces', '#1D2027',
    'Board columns, cards, Settings panels, the Admin Dashboard panels.'),
  t('surface.raised', 'surface-2', 'Raised surface', 'Surfaces', '#262A33',
    'Inputs, the tab bar, chips, the header pickers, a hovered table row.'),
  t('surface.raised.strong', 'surface-3', 'Strongest surface', 'Surfaces', '#30343E',
    'The active tab, counters on sub-tabs, a hovered secondary button.'),
  t('surface.border', 'border', 'Border and divider', 'Surfaces', '#363B46',
    'Every panel edge, input border, table rule and the sprocket strip.'),
  t('surface.sunk', 'surface-sunk', 'Sunk surface', 'Surfaces', '#7F7F7F',
    'The one inset panel \u2014 a wrapped URL in Settings. Drawn at a tenth, so it '
    + 'works on any background.', { alphas: { t10: 0.10 } }),
  t('surface.code', 'code-bg', 'Code block background', 'Surfaces', '#15171D',
    'Behind a copyable address or fingerprint in Settings.'),
  t('surface.dragover', 'dragover', 'Column under a dragged card', 'Surfaces', '#231A15',
    'A board column while a card is being dragged over it.'),
  /* OVERLAYS AND SHADOWS ARE SOLID TOKENS WITH DERIVED ALPHAS, not translucent
     values. The stylesheet used each of these at several alphas — black at six
     of them — and a token per alpha would be six rows in Settings for one idea.
     The editable value is the colour; the alphas come with it. */
  t('surface.overlay', 'overlay', 'Overlay behind a panel', 'Surfaces', '#0A0B0E',
    'The dimming behind a modal and the drawer.',
    { alphas: { t60: 0.6, t65: 0.65 } }),
  t('surface.overlay.tour', 'overlay-tour', 'Quick Tour veil', 'Surfaces', '#08090C',
    'The veil the Quick Tour draws over the page while it points at things.',
    { alphas: { t72: 0.72 } }),
  t('surface.shadow', 'shadow', 'Drop shadow', 'Surfaces', '#000000',
    'Under the notification panel, the drawer, toasts, menus and tooltips.',
    { alphas: { t28: 0.28, t30: 0.30, t32: 0.32, t42: 0.42, t45: 0.45, t55: 0.55 } }),
  t('surface.scrim', 'scrim', 'Scrim on an image', 'Surfaces', '#12121A',
    'The download button drawn over a chat image, which has to be legible on '
    + 'whatever the picture happens to be.',
    { alphas: { t72: 0.72, t92: 0.92 } }),
  t('surface.hairline', 'hairline', 'Hairline on a dark surface', 'Surfaces', '#FFFFFF',
    'The faintest rules in the application \u2014 a swatch edge, the Activity '
    + 'Log\u2019s row lines, the primary button\u2019s inner edge. Used only at '
    + 'very low opacity.', { alphas: { t05: 0.05, t10: 0.10, t14: 0.14 } }),
  t('surface.toast', 'toast', 'Toast background', 'Surfaces', '#262A33',
    'The short-lived message that appears bottom-left after an action.'),

  // --- Text -----------------------------------------------------------------
  t('text.primary', 'ink', 'Primary text', 'Text', '#EDEFF2',
    'Body text, headings, the active tab’s label.'),
  t('text.secondary', 'ink-muted', 'Secondary text', 'Text', '#8B909C',
    'Inactive tab labels, table headings, sub-headings.'),
  t('text.muted', 'ink-faint', 'Muted text', 'Text', '#5B606C',
    'Field labels, notes, counts, anything deliberately quiet.'),
  t('text.link', 'brand-accent', 'Link and accent', 'Text', '#EF6B6F',
    'Links, the active sub-tab, the focus ring, the accent on every screen. '
    + 'The brand red lifted until it can be read on the page background.'),
  t('text.on.brand', 'brand-ink', 'Text on the brand colour', 'Text', '#FFFFFF',
    'The wordmark letter, the primary button’s label, a filled chip.'),
  t('text.on.accent', 'accent-ink', 'Text on the accent colour', 'Text', '#12080A',
    'The label inside a filled accent badge — the tab counter and the role pill.'),

  // --- Navigation tabs ------------------------------------------------------
  t('nav.bar.background', 'tabbar-bg', 'Tab bar background', 'Navigation tabs', '#262A33',
    'The strip the main tabs sit in.'),
  t('nav.bar.border', 'tabbar-border', 'Tab bar border', 'Navigation tabs', '#363B46',
    'The edge around the tab strip.'),
  t('nav.tab.text', 'tab-ink', 'Inactive tab text', 'Navigation tabs', '#8B909C',
    'A tab you are not on.'),
  t('nav.tab.background', 'tab-bg', 'Inactive tab background', 'Navigation tabs', '#00000000',
    'Transparent, so the bar shows through. Set a colour to give every tab its '
    + 'own block.', { alpha: true }),
  t('nav.tab.active.text', 'tab-active-ink', 'Active tab text', 'Navigation tabs', '#EDEFF2',
    'The tab you are on.'),
  t('nav.tab.active.background', 'tab-active-bg', 'Active tab background', 'Navigation tabs', '#30343E',
    'Behind the tab you are on.'),
  /* THE MAIN TABS HAD NO HOVER STATE AT ALL, and these two defaults say so: the
     background is fully transparent and the text is the same grey an inactive
     tab already is, so an untouched studio sees exactly what it saw before. The
     :hover rule now exists and reads them, so a studio that sets either gets a
     hover state without a deploy. Reported rather than quietly invented. */
  t('nav.tab.hover.text', 'tab-hover-ink', 'Tab text on hover', 'Navigation tabs', '#8B909C',
    'A tab under the pointer. Defaults to the inactive colour \u2014 this '
    + 'application had no tab hover state before.'),
  t('nav.tab.hover.background', 'tab-hover-bg', 'Tab background on hover', 'Navigation tabs', '#00000000',
    'Behind a tab under the pointer. Transparent by default, for the same '
    + 'reason.', { alpha: true }),
  t('nav.tab.indicator', 'tab-indicator', 'Active tab indicator', 'Navigation tabs', '#00000000',
    'A mark down the inside edge of the tab you are on. Transparent by default: '
    + 'this application marks the active tab by its background, and a 2px bar '
    + 'nobody asked for is a change of appearance, not a theme. Set it to make '
    + 'the mark appear.', { alpha: true }),
  /* THE BADGE IS THE DOT COLOUR AT TWO ALPHAS, derived rather than three tokens a
     studio would have to keep in step with each other by hand. */
  t('nav.tab.badge.dot', 'tab-badge-dot', 'Tab badge', 'Navigation tabs', '#EF6B6F',
    'The dot, the wash behind it and the edge around a tab that has something '
    + 'waiting on it.', { alphas: { t1f: '1F', t66: '66' } }),
  t('nav.focus.ring', 'focus-ring', 'Focus ring', 'Navigation tabs', '#EF6B6F',
    'The outline around whatever the keyboard is on. Every focusable control '
    + 'in the application uses this one colour.'),

  // --- Sub-tabs -------------------------------------------------------------
  t('subtab.text', 'subtab-ink', 'Sub-tab text', 'Sub-tabs', '#8B909C',
    'An inactive sub-tab, on every sub-tab group — Reports, the Assets List, '
    + 'Pending Actions, Outsource, Art/Animation, Team Capacity, Follow Up.'),
  t('subtab.background', 'subtab-bg', 'Sub-tab background', 'Sub-tabs', '#00000000',
    'Transparent by default.', { alpha: true }),
  t('subtab.hover.text', 'subtab-hover-ink', 'Sub-tab text on hover', 'Sub-tabs', '#EDEFF2',
    'A sub-tab under the pointer.'),
  t('subtab.hover.background', 'subtab-hover-bg', 'Sub-tab background on hover', 'Sub-tabs', '#262A33',
    'Behind a sub-tab under the pointer.'),
  t('subtab.active.text', 'subtab-active-ink', 'Active sub-tab text', 'Sub-tabs', '#EDEFF2',
    'The sub-tab you are on.'),
  t('subtab.active.background', 'subtab-active-bg', 'Active sub-tab background', 'Sub-tabs', '#262A33',
    'Behind the sub-tab you are on.'),
  t('subtab.active.border', 'subtab-active-border', 'Active sub-tab border', 'Sub-tabs', '#363B46',
    'The edge around the sub-tab you are on.'),
  t('subtab.indicator', 'subtab-indicator', 'Active sub-tab underline', 'Sub-tabs', '#EF6B6F',
    'The underline on the Outsource sub-tabs, and the accent on an active '
    + 'sub-tab’s counter.'),
  t('subtab.count.text', 'subtab-count-ink', 'Sub-tab counter text', 'Sub-tabs', '#5B606C',
    'The number beside a sub-tab’s label.'),
  t('subtab.count.background', 'subtab-count-bg', 'Sub-tab counter background', 'Sub-tabs', '#30343E',
    'Behind that number.'),

  // --- Buttons --------------------------------------------------------------
  t('button.primary.background', 'brand', 'Primary button', 'Buttons', '#7F1416',
    'The studio red. Sign in, Save, and every other committing action. Also the '
    + 'wordmark square and the unread marker in chat.',
    { alphas: { t10: 0.10, t20: 0.20, t22: 0.22, t26: 0.26, t28: 0.28, t44: 0.44 } }),
  t('button.primary.hover', 'brand-hover', 'Primary button on hover', 'Buttons', '#96181B',
    'The same button under the pointer.'),
  t('button.secondary.background', 'btn-ghost-bg', 'Secondary button', 'Buttons', '#262A33',
    'Cancel, Close, and the quieter half of every pair of buttons.'),
  t('button.secondary.text', 'btn-ghost-ink', 'Secondary button text', 'Buttons', '#EDEFF2',
    'The label on a secondary button.'),
  t('button.secondary.hover', 'btn-ghost-hover', 'Secondary button on hover', 'Buttons', '#30343E',
    'A secondary button under the pointer.'),
  t('button.danger.text', 'danger-ink', 'Destructive action text', 'Buttons', '#E8402C',
    'Request Changes, Decline, Delete — drawn as a red label on a secondary '
    + 'button rather than a filled red one.',
    { alphas: { t14: '14', t22: '22', t44: '44', t66: '66' } }),

  // --- Forms ----------------------------------------------------------------
  t('form.input.background', 'input-bg', 'Input background', 'Forms', '#262A33',
    'Text fields, selects, textareas.'),
  t('form.input.border', 'input-border', 'Input border', 'Forms', '#363B46',
    'The edge of a field at rest.'),
  t('form.input.focus.border', 'input-focus-border', 'Input border on focus', 'Forms', '#EF6B6F',
    'The edge of the field you are typing in.'),
  t('form.placeholder', 'placeholder-ink', 'Placeholder text', 'Forms', '#5B606C',
    'The hint inside an empty field.'),
  t('form.accent', 'form-accent', 'Checkbox and selection accent', 'Forms', '#EF6B6F',
    'Checkboxes, radio buttons, the colour a text selection is drawn in.'),
  /* THERE IS NO SELECTED-ROW COLOUR IN THIS APPLICATION and so there is no token
     for one: a ticked row in the Assets List is marked by its checkbox and
     nothing else. Adding a highlight would be a new appearance, which this
     change must not invent. Reported instead. */

  // --- Tables ---------------------------------------------------------------
  t('table.header.background', 'thead-bg', 'Table heading background', 'Tables', '#262A33',
    'Behind a column heading.'),
  t('table.header.text', 'thead-ink', 'Table heading text', 'Tables', '#8B909C',
    'Column headings.'),
  t('table.row.background', 'row-bg', 'Table row background', 'Tables', '#00000000',
    'Transparent today.', { alpha: true }),
  t('table.row.hover', 'row-hover', 'Table row on hover', 'Tables', '#262A33',
    'A row under the pointer.'),
  t('table.border', 'table-border', 'Table rule', 'Tables', '#363B46',
    'The line under each row.'),

  // --- Meaning --------------------------------------------------------------
  t('meaning.success', 'approved', 'Success', 'Meaning', '#3DDC97',
    'Something worked. Also the Approved for Client status and the On Track card.',
    { alphas: { t14: '14', t44: '44' } }),
  t('meaning.success.text', 'success-ink', 'Success text', 'Meaning', '#7FDCB0',
    'The words inside a success banner, readable on its tint.'),
  t('meaning.warning', 'prog', 'Warning', 'Meaning', '#F2B33D',
    'A soft caution. Also the In Progress status and the At Risk card.',
    { alphas: { t14: '14', t55: '55', t16: 0.16 } }),
  t('meaning.warning.text', 'warning-ink', 'Warning text', 'Meaning', '#FFCC70',
    'The words inside a warning banner.'),
  t('meaning.error', 'error', 'Error', 'Meaning', '#E8402C',
    'A refusal, a failed check, a validation message.',
    { alphas: { t14: '14', t22: '22', t44: '44', t66: '66' } }),
  t('meaning.error.text', 'error-ink', 'Error text', 'Meaning', '#FF9B80',
    'The words inside an error banner.'),
  t('meaning.info', 'info', 'Information', 'Meaning', '#4DB8FF',
    'A neutral notice — monitor mode, an explanatory banner.',
    { alphas: { t10: 0.10, t14: 0.14, t30: 0.30, t50: 0.5 } }),
  t('meaning.info.text', 'info-ink', 'Information text', 'Meaning', '#8ECDFF',
    'The words inside an information banner.'),
  t('meaning.at_risk', 'at-risk', 'At Risk', 'Meaning', '#E8A33D',
    'Work due soon and unfinished — the Admin Dashboard card, the timesheet '
    + 'over-hours flag, the one-active-task notice.',
    { alphas: { t14: '14', t1f: '1F', t33: '33', t44: '44', t66: '66' } }),
  t('meaning.overdue', 'overdue', 'Overdue', 'Meaning', '#FF5A36',
    'Already past a due date \u2014 and the P&L\u2019s losses, which are the same '
    + 'kind of fact. Nine derived alphas, because the shipped stylesheet drew this '
    + 'one colour at nine of them.',
    { alphas: { t08: 0.08, t09: 0.09, t10: 0.10, t12: 0.12, t15: 0.15, t16: 0.16,
      t30: 0.30, t32: 0.32, t45: 0.45 } }),
  t('meaning.unassigned', 'not', 'Not assigned', 'Meaning', '#6B7280',
    'Nobody is on it yet \u2014 the Not Assigned column and the unassigned pill. A '
    + 'second, cooler grey than Neutral below, which is what the shipped palette had.'),
  t('meaning.neutral', 'neutral', 'Neutral', 'Meaning', '#6B7A8F',
    'Nothing to report — an inactive row, an unassigned pill, a closed day.'),
  t('meaning.paused', 'paused', 'On hold', 'Meaning', '#3B4252',
    'A task somebody has put down. Deliberately slate rather than a warning '
    + 'colour: a held task is not in trouble.'),
  t('meaning.paused.text', 'paused-ink', 'On hold text', 'Meaning', '#C6CCD8',
    'The words on a hold badge.'),
  t('meaning.paused.border', 'paused-border', 'On hold border', 'Meaning', '#4C566A',
    'The edge of a hold badge.'),
  t('meaning.read', 'read-tick', 'Read receipt', 'Meaning', '#3AA3FF',
    'The two blue ticks in chat. The one mark in the application whose colour is '
    + 'its meaning — everybody reads blue ticks as "they have seen it".'),

  /* --- the washes -----------------------------------------------------------
   *
   * THE SHIPPED PALETTE USED A DIFFERENT BASE FOR A TINT THAN FOR THE SOLID, and
   * it is not a mistake: #40C88C washed at a tenth reads as the same green as
   * #3DDC97 solid, where #3DDC97 at a tenth reads grey. Two tokens, because
   * collapsing them would change how every success banner in the application
   * looks — which is the one thing this change must not do. */
  t('meaning.success.wash', 'success-wash', 'Success wash', 'Meaning', '#40C88C',
    'The background and edge of a success banner, and the "yours" marker on a '
    + 'project member. Only ever drawn translucent.',
    { alphas: { t07: 0.07, t10: 0.10, t16: 0.16, t30: 0.30, t45: 0.45, t70: 0.7 } }),
  t('meaning.warning.wash', 'warning-wash', 'Warning wash', 'Meaning', '#FFB020',
    'The background and edge of a warning banner, a pending tag, a read-only '
    + 'notice. Only ever drawn translucent.',
    { alphas: { t10: 0.10, t12: 0.12, t13: 0.13, t28: 0.28, t30: 0.30, t32: 0.32 } }),
  t('meaning.warning.strong', 'warning-strong', 'Strong warning edge', 'Meaning', '#E0A800',
    'The border of the Recording Hours warning \u2014 a deeper amber than the '
    + 'banner washes.', { alphas: { t08: 0.08 } }),
  t('meaning.warning.pale', 'warning-pale', 'Pale warning text', 'Meaning', '#FFD98A',
    'The words in the project-members warning, which sits on a gold wash.'),
  t('meaning.at_risk.text', 'at-risk-ink', 'At Risk text', 'Meaning', '#E0A458',
    'The "not priced" marker in the P&L.'),
  t('meaning.error.strong', 'error-strong', 'Hard error edge', 'Meaning', '#D9534F',
    'The border and message on a Recording Hours field that will not save.'),
  t('meaning.error.heading', 'error-heading', 'Fault heading', 'Meaning', '#FF7A55',
    'The heading of the database-fault banner.'),
  t('meaning.error.body', 'error-body', 'Fault body text', 'Meaning', '#FFB9A5',
    'The paragraph under that heading.'),
  t('meaning.error.code', 'error-code', 'Fault code text', 'Meaning', '#FFD3C6',
    'The monospaced detail inside that banner.'),
  t('meaning.outsourced', 'outsourced', 'With a freelancer', 'Meaning', '#2E7D5B',
    'The dot on a card that is out with a freelancer, and the Delivered stage '
    + 'on the Outsource tab.'),
  t('meaning.outsourced.text', 'outsourced-ink', 'With a freelancer text', 'Meaning', '#8FD3B0',
    'The words beside that dot.'),
  t('meaning.archived', 'archived', 'Archived', 'Meaning', '#6B6B6B',
    'The badge on an archived project.', { alphas: { t33: '33' } }),
  t('meaning.archived.text', 'archived-ink', 'Archived text', 'Meaning', '#A8A8A8',
    'The word inside that badge.'),
  t('meaning.closed', 'closed', 'Closed with the client', 'Meaning', '#C9A227',
    'The badge on a project the studio has closed out.', { alphas: { t22: '22' } }),
  t('meaning.closed.text', 'closed-ink', 'Closed text', 'Meaning', '#D8B53F',
    'The word inside that badge.'),
  t('meaning.paused.muted', 'paused-muted', 'On hold, quietly', 'Meaning', '#9AA4B8',
    'The held stamp under a card and the note beside it \u2014 quieter than the '
    + 'badge itself.'),
  t('meaning.stage.working', 'stage-working', 'Outsource: in progress', 'Meaning', '#2F6F9F',
    'The pill on freelancer work that is under way.'),
  t('meaning.stage.completed', 'stage-completed', 'Outsource: completed', 'Meaning', '#5A4FBF',
    'The pill on freelancer work that is finished but not handed back.'),
  t('meaning.stage.revision', 'stage-revision', 'Outsource: revision asked for', 'Meaning', '#B8860B',
    'The pill on freelancer work sent back for a correction.'),
  t('text.on.accent.deep', 'accent-ink-deep', 'Text on a filled role pill', 'Meaning', '#1A0E0E',
    'The designation inside the filled pill beside somebody\u2019s name.'),

  // --- Charts and tiles -----------------------------------------------------
  t('chart.series.1', 'artist-blue', 'Series 1', 'Charts and tiles', '#4FB3FF',
    'The artist blue. First series in a breakdown, and the Active card.'),
  t('chart.series.2', 'review', 'Series 2', 'Charts and tiles', '#9B7EF0',
    'Review violet. Second series, and the TL/CD review statuses.',
    { alphas: { t14: '14', t44: '44', t55: '55', taa: 'AA' } }),
  t('chart.series.3', 'final', 'Series 3', 'Charts and tiles', '#D4FF3D',
    'Delivered lime. Third series, and the Delivered card.'),
  t('chart.series.4', 'client', 'Series 4', 'Charts and tiles', '#22C1C3',
    'Client teal. Fourth series, and Awaiting Client Feedback.'),
  t('chart.series.5', 'series-5', 'Series 5', 'Charts and tiles', '#5B8DEF',
    'Assigned blue. Fifth series.'),
  t('chart.series.6', 'series-6', 'Series 6', 'Charts and tiles', '#D9822B',
    'Game feedback amber. Sixth series, and the Idle figure on a timesheet.',
    { alphas: { t08: 0.08, t14: '14', t44: '44' } }),
  t('chart.series.7', 'series-7', 'Series 7', 'Charts and tiles', '#4C9A75',
    'The deep green of a team lead\u2019s approval. Seventh series.'),
  t('chart.tile.border', 'tile-border', 'Stat tile top rule', 'Charts and tiles', '#363B46',
    'The rule across the top of a stat tile before its own colour is applied.'),
  t('chart.leadership', 'leadership', 'Top of hierarchy', 'Charts and tiles', '#FFD23D',
    'The gold on a leadership designation and the top-of-hierarchy marker.',
    { alphas: { t10: 0.10, t30: 0.30 } }),

  // --- Sign-in --------------------------------------------------------------
  t('login.page.background', 'login-bg', 'Sign-in page background', 'Sign-in', '#14161B',
    'Behind the sign-in card, before anybody has signed in.'),
  t('login.card.background', 'login-card', 'Sign-in card', 'Sign-in', '#1D2027',
    'The panel the email and password fields sit in.'),
  t('login.card.border', 'login-card-border', 'Sign-in card border', 'Sign-in', '#363B46',
    'The edge of that panel.'),
  t('login.error.text', 'login-err', 'Sign-in error text', 'Sign-in', '#EF6B6F',
    'The message under the fields when a sign-in is refused.'),
];

/* ---------------------------------------------------------------------------
 * WORKFLOW STATUSES, GENERATED FROM THE PIPELINE'S OWN LIST.
 *
 * One token per status, so a studio can recolour its board columns and badges.
 * Built from src/asset-workflow.js rather than written out, which is what makes
 * a status added next year appear in Settings with no edit here — and what makes
 * the fallback below matter: a status whose colour is not one of the palette
 * entries this file knows gets STATUS_FALLBACK rather than nothing, so a new
 * status is grey instead of invisible. tests/theme.test.js pins that.
 *
 * `var(--x)` in the pipeline's own list means "the palette decides", and those
 * statuses are mapped onto the token that already held them. A literal means the
 * status owns its colour, and becomes a token of its own.
 */
const STATUS_FALLBACK = '#6B7A8F';

/* THE COLOUR EACH STATUS SHIPPED WITH.
 *
 * HERE RATHER THAN IN src/asset-workflow.js, and that is a move: the pipeline's
 * own list used to carry the colours, half as palette references and half as
 * literals. It now carries `var(--status-<id>)` for every state, so the workflow
 * owns ids, labels and transitions while this file owns colour — which is what
 * lets a studio recolour a board column without editing the pipeline, and what
 * keeps the one list of colour literals in the application in one place.
 *
 * A STATUS WITH NO ENTRY HERE GETS STATUS_FALLBACK, which is the whole point of
 * generating these from the pipeline's list rather than writing them out: a
 * status added next year appears in Settings as a grey anybody can change,
 * rather than as an invisible column. tests/theme.test.js adds a fictional
 * status and asserts exactly that.
 */
const STATUS_DEFAULTS = {
  not_started: '#6B7280',
  assigned: '#5B8DEF',
  in_progress: '#F2B33D',
  pending_tl_review: '#9B7EF0',
  tl_changes_requested: '#E8402C',
  tl_approved: '#4C9A75',
  pending_cd_review: '#9B7EF0',
  cd_changes_requested: '#E8402C',
  game_feedback: '#D9822B',
  approved_for_client: '#3DDC97',
  awaiting_client_feedback: '#22C1C3',
  delivered: '#D4FF3D',
};

/* One token per status, so a studio can recolour its board columns and badges.
 * Built from the pipeline's own list rather than written out, which is what
 * makes a status added next year appear in Settings with no edit here. */
function statusTokens(states) {
  return (states || []).map((s) => {
    const want = STATUS_DEFAULTS[s.id];
    const checked = want ? canonical(want) : { error: true };
    return t(`status.${s.id}`, `status-${s.id.replace(/_/g, '-')}`,
      s.label, 'Workflow statuses',
      checked.error ? STATUS_FALLBACK : checked.value,
      `The ${s.label} column heading and status badge.`,
      /* The badge is the status colour as TEXT on the same colour at 0x22 — see
         .status-pill. The page used to build that by concatenating '22' onto the
         hex, which stops working the moment the colour is a var(); the tint is a
         property of its own now. */
      { alphas: { t22: '22' } });
  });
}

/* ---------------------------------------------------------------------------
 * VALIDATION.
 *
 * Canonical form is UPPERCASE and six digits — or eight where the token allows
 * alpha. #RGB expands. Everything else is refused, and the caller names which
 * token it was.
 *
 * THE OUTPUT IS BUILT FROM THE MATCHED DIGITS, not from the input string. That
 * is the whole of the injection defence: there is no path by which
 * `red; } body { display:none`, `url(javascript:…)` or `expression(…)` can
 * survive this function, because nothing of the input is carried forward except
 * characters that matched [0-9a-fA-F].
 */
function canonical(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (SHORT.test(text)) {
    const [, r, g, b] = text;
    return { value: `#${r}${r}${g}${g}${b}${b}`.toUpperCase() };
  }
  if (SIX.test(text)) return { value: text.toUpperCase() };
  if (EIGHT.test(text)) return { value: text.toUpperCase(), alpha: true };
  return { error: true };
}

module.exports = {
  GROUPS, TOKENS, STATUS_FALLBACK, STATUS_DEFAULTS, statusTokens, canonical,
  MAX_BODY_BYTES, MAX_PRESETS, HISTORY_LIMIT,
  SHORT, SIX, EIGHT,
};
