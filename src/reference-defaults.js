// The values the studio starts with.
//
// These used to be arrays in the source; they are now the seed for the
// asset_types, priorities and roles tables, applied by src/migrate.js the first
// time it finds those tables empty. Editing this file changes what a brand new
// database gets, and nothing else: once a studio is running, its values live in
// the database and are managed in Settings.
//
// The role list was generated from the catalogue that preceded these tables,
// with each role's tier derived by matching its capabilities against
// src/role-tiers.js, so no role's permissions changed in the move.

// Colours match the icons the board draws for each type.
const ASSET_TYPES = [
  { key: 'character',   label: 'Character',   codePrefix: 'CHR', color: '#ff5a36', position: 60, isSystem: false },
  { key: 'prop',        label: 'Prop',        codePrefix: 'PRP', color: '#f2b33d', position: 50, isSystem: false },
  { key: 'environment', label: 'Environment', codePrefix: 'ENV', color: '#3ddc97', position: 40, isSystem: false },
  { key: 'fx',          label: 'FX',          codePrefix: 'FX',  color: '#9b7ef0', position: 30, isSystem: false },
  { key: 'animation',   label: 'Animation',   codePrefix: 'ANI', color: '#4fb3ff', position: 20, isSystem: false },
  { key: 'background',  label: 'Background',  codePrefix: 'BG',  color: '#d4ff3d', position: 10, isSystem: false },
];

// 'med' rather than 'medium' because that is the value existing assets hold.
const PRIORITIES = [
  { key: 'high', label: 'High',   color: '#ff5a36', position: 30, isSystem: false },
  { key: 'med',  label: 'Medium', color: '#f2b33d', position: 20, isSystem: false },
  { key: 'low',  label: 'Low',    color: '#6b7a8f', position: 10, isSystem: false },
];

/* The stages a project is planned in.
 *
 * Two, and only two, because those are the two the studio named — and unlike
 * the category lists, which start empty so nothing is assumed about how a
 * studio groups its work, this one has to start non-empty: the Milestones
 * column cannot be used at all until at least one type exists, and shipping an
 * empty list would mean the feature does nothing until somebody finds Settings.
 * Rigging, Lighting and the rest are added there, not here.
 *
 * Colours are the two the board already uses for those words, so a milestone
 * chip and an Animation asset are not two different blues. */
const MILESTONE_TYPES = [
  { key: 'art',       label: 'Art',       color: '#ff5a36', position: 20, isSystem: false },
  { key: 'animation', label: 'Animation', color: '#4fb3ff', position: 10, isSystem: false },
];

/* WHAT A TIMESHEET DAY CAN BE SPENT ON THAT IS NOT A PROJECT.
 *
 * These were a hardcoded array in src/timesheets.js. They are reference data
 * now, so a studio can add "Recruitment" or retire "Training" in Settings
 * without a deploy — but they are SEEDED rather than starting empty, unlike the
 * two category lists, for the reason the old comment gave: "a timesheet that
 * cannot be filled in until somebody configures a list is a timesheet nobody
 * fills in."
 *
 * position descends, matching every other list here, so the order below is the
 * order of the dropdown.
 *
 * IDLE IS A SYSTEM VALUE and the only one of the six. isSystem means it can be
 * RENAMED but not deactivated and not deleted — see update() and remove() in
 * src/reference-data.js. It is protected because code keys off it: the week's
 * totals split idle time out from project work and from other non-project time,
 * so a studio that deactivated it would leave that split reading nought while
 * the hours were still being logged somewhere. The other five are protected the
 * ordinary way, by `usedBy` — they cannot be deleted while lines reference them,
 * and deactivating one is a legitimate thing to want.
 *
 * The code always says 'idle', never "Idle": a studio renaming it to "Bench
 * time" or "Unallocated" changes the label and nothing keys off the label. */
const TIMESHEET_CATEGORIES = [
  { key: 'leave',    label: 'Leave',            color: '#9b7ef0', position: 60, isSystem: false },
  { key: 'holiday',  label: 'Holiday',          color: '#4fb3ff', position: 50, isSystem: false },
  { key: 'meeting',  label: 'Internal Meeting', color: '#2f6f9f', position: 40, isSystem: false },
  { key: 'training', label: 'Training',         color: '#4c9a75', position: 30, isSystem: false },
  /* ADDED WITH THE SUB-OPTIONS, because its three sub-options need a parent and
     it did not exist. The other two the studio asked for — Idle and Training —
     were already here.
     
     NOT isSystem: Idle is protected because the week's totals count it
     separately and a studio that retired it would leave that figure reading
     nought while the hours were still logged. Nothing keys on On Site, so it
     is renameable and retirable like Training beside it, which is Prompt 24's
     rule for an ordinary category. */
  { key: 'on_site',  label: 'On Site',          color: '#3f8ea7', position: 25, isSystem: false },
  { key: 'admin',    label: 'Admin',            color: '#6b7a8f', position: 20, isSystem: false },
  /* Last in the dropdown and lowest in the order: it is the one somebody picks
     when there was nothing to pick, and it should not sit above the things they
     might actually have been doing. */
  { key: 'idle',     label: 'Idle',             color: '#d9822b', position: 10, isSystem: true },
];

/* THE HEADING EACH CATEGORY'S SECOND DROPDOWN CARRIES, seeded into
 * timesheet_categories.sub_label so a Super Admin can rename "Idle Remarks"
 * without a deploy. Only a seed: the migration writes one only where the column
 * is still NULL, so a renamed heading is never reverted.
 *
 * The studio named the first; the other two are ours, and the report says so:
 * "Training Type" and "On Site Client" read as questions the dropdown answers,
 * which is what "Idle Remarks" does for Idle.
 */
const TIMESHEET_SUB_LABELS = {
  idle: 'Idle Remarks',
  training: 'Training Type',
  on_site: 'On Site Client',
};

/* THE SECOND DROPDOWN'S OPTIONS, per category.
 *
 * ONE MECHANISM, THREE SEEDED USES. Nothing here is special-cased: a category
 * with sub-options gets a second dropdown, a category without one does not, and
 * attaching options to Leave tomorrow is three rows in Settings and no code.
 *
 * THE KEY IS <parent>_<label reduced to a key>, derived by the same rule
 * src/reference-data.js uses for anything an admin adds later, so a seeded
 * option and an added one are indistinguishable afterwards. It is what the line
 * stores, so a rename changes every old line's label and breaks no report.
 * `training_training_2d_art` is clumsy and deliberate: a hand-tidied key here
 * would be a key the code could not have produced.
 *
 * LABELS EXACTLY AS THE STUDIO WROTE THEM, including "Assigned work Completed"
 * beside "Assigned Work Late". The inconsistent capital is theirs; normalising
 * it quietly would be deciding something they can decide for themselves, and
 * the report asks them to. Renaming either is one click in Settings and changes
 * nothing stored.
 *
 * POSITION DESCENDS, like every other reference list — the loader orders by
 * position DESC — so the first in each list below is the first in the dropdown.
 */
const TIMESHEET_SUB_OPTIONS = [
  { parentKey: 'idle', key: 'idle_no_work_to_assign',        label: 'No Work to Assign',       position: 70 },
  { parentKey: 'idle', key: 'idle_system_issues',            label: 'System Issues',           position: 60 },
  { parentKey: 'idle', key: 'idle_awaiting_client_feedback', label: 'Awaiting Client Feedback', position: 50 },
  { parentKey: 'idle', key: 'idle_assigned_work_completed',  label: 'Assigned work Completed', position: 40 },
  { parentKey: 'idle', key: 'idle_assigned_work_late',       label: 'Assigned Work Late',      position: 30 },
  { parentKey: 'idle', key: 'idle_left_early',               label: 'Left Early',              position: 20 },
  { parentKey: 'idle', key: 'idle_late_login',               label: 'Late Login',              position: 10 },

  { parentKey: 'training', key: 'training_training_2d_art',       label: 'Training 2D Art',       position: 30 },
  { parentKey: 'training', key: 'training_training_2d_animation', label: 'Training 2D Animation', position: 20 },
  { parentKey: 'training', key: 'training_training_game_design',  label: 'Training Game Design',  position: 10 },

  { parentKey: 'on_site', key: 'on_site_csr2_on_site',             label: 'CSR2 On Site',             position: 30 },
  { parentKey: 'on_site', key: 'on_site_scopely_on_site',          label: 'Scopely On Site',          position: 20 },
  { parentKey: 'on_site', key: 'on_site_scientific_games_on_site', label: 'Scientific Games On Site', position: 10 },
];

const ROLES = [
  {
    key: "super_admin",
    label: "Super Admin",
    group: "Administration",
    tier: "super_admin",
    color: "#ff3b5c",
    position: 100,
    isSystem: true
  },
  {
    key: "admin",
    label: "Admin",
    group: "Administration",
    tier: "admin",
    color: "#5b8cff",
    position: 90,
    isSystem: true
  },
  {
    key: "coordinator",
    label: "Production Coordinator",
    group: "Administration",
    tier: "production",
    color: "#39d98a",
    position: 60,
    isSystem: false
  },
  {
    key: "art_director",
    label: "Art Director",
    group: "Creative Direction",
    tier: "direction",
    color: "#d4ff3d",
    position: 85,
    isSystem: false
  },
  {
    key: "creative_art_director",
    label: "Creative Art Director",
    group: "Creative Direction",
    tier: "direction",
    color: "#d4ff3d",
    position: 86,
    isSystem: false
  },
  {
    key: "associate_art_director",
    label: "Associate Art Director",
    group: "Creative Direction",
    tier: "lead",
    color: "#d4ff3d",
    position: 78,
    isSystem: false
  },
  {
    key: "art_supervisor",
    label: "Art Supervisor",
    group: "Supervision",
    tier: "lead",
    color: "#ffa63d",
    position: 75,
    isSystem: false
  },
  {
    key: "associate_animation_supervisor",
    label: "Associate Animation Supervisor",
    group: "Supervision",
    tier: "lead",
    color: "#ffa63d",
    position: 70,
    isSystem: false
  },
  {
    key: "senior_team_lead",
    label: "Senior Team Lead",
    group: "Supervision",
    tier: "lead",
    color: "#ff8a3d",
    position: 72,
    isSystem: false
  },
  {
    key: "team_lead",
    label: "Team Lead",
    group: "Supervision",
    tier: "lead",
    color: "#ff8a3d",
    position: 68,
    isSystem: false
  },
  {
    key: "associate_team_lead",
    label: "Associate Team Lead",
    group: "Supervision",
    tier: "lead",
    color: "#ff8a3d",
    position: 65,
    isSystem: false
  },
  {
    key: "technical_manager",
    label: "Technical Manager",
    group: "Supervision",
    tier: "lead",
    color: "#ffa63d",
    position: 74,
    isSystem: false
  },
  {
    key: "senior_game_artist",
    label: "Senior Game Artist",
    group: "Art",
    tier: "contributor",
    color: "#4db8ff",
    position: 50,
    isSystem: false
  },
  {
    key: "game_artist",
    label: "Game Artist",
    group: "Art",
    tier: "contributor",
    color: "#4db8ff",
    position: 40,
    isSystem: false
  },
  {
    key: "associate_game_artist",
    label: "Associate Game Artist",
    group: "Art",
    tier: "contributor",
    color: "#4db8ff",
    position: 30,
    isSystem: false
  },
  {
    key: "trainee_game_artist",
    label: "Trainee Game Artist",
    group: "Art",
    tier: "contributor",
    color: "#4db8ff",
    position: 10,
    isSystem: false
  },
  {
    key: "senior_motion_graphics_artist",
    label: "Senior Motion Graphics Artist",
    group: "Art",
    tier: "contributor",
    color: "#4db8ff",
    position: 50,
    isSystem: false
  },
  {
    key: "senior_game_animator",
    label: "Senior Game Animator",
    group: "Animation",
    tier: "contributor",
    color: "#b98cff",
    position: 50,
    isSystem: false
  },
  {
    key: "game_animator",
    label: "Game Animator",
    group: "Animation",
    tier: "contributor",
    color: "#b98cff",
    position: 40,
    isSystem: false
  },
  {
    key: "associate_game_animator",
    label: "Associate Game Animator",
    group: "Animation",
    tier: "contributor",
    color: "#b98cff",
    position: 30,
    isSystem: false
  },
  {
    key: "trainee_game_animator",
    label: "Trainee Game Animator",
    group: "Animation",
    tier: "contributor",
    color: "#b98cff",
    position: 10,
    isSystem: false
  },
  {
    key: "game_designer",
    label: "Game Designer",
    group: "Design",
    tier: "contributor",
    color: "#ff7ac2",
    position: 45,
    isSystem: false
  },
  {
    key: "senior_ui_ux_designer",
    label: "Senior UI/UX Designer",
    group: "Design",
    tier: "contributor",
    color: "#ff7ac2",
    position: 50,
    isSystem: false
  },
  {
    key: "associate_ui_ux_designer",
    label: "Associate - UI/UX Designer",
    group: "Design",
    tier: "contributor",
    color: "#ff7ac2",
    position: 30,
    isSystem: false
  },
  {
    key: "associate_game_designer",
    label: "Associate Game Designer",
    group: "Design",
    tier: "contributor",
    color: "#ff7ac2",
    position: 30,
    isSystem: false
  },
  {
    key: "consultant_lead_game_designer",
    label: "Consultant - Lead Game Designer",
    group: "Design",
    tier: "contributor",
    color: "#ff7ac2",
    position: 55,
    isSystem: false
  },
  {
    key: "head_of_production",
    label: "Head of Production",
    group: "Production",
    tier: "full_access",
    color: "#ffd23d",
    position: 92,
    isSystem: false
  },
  {
    key: "cto",
    label: "CTO",
    group: "Leadership",
    tier: "full_access",
    color: "#ffd23d",
    position: 94,
    isSystem: false
  },
  {
    key: "general_manager",
    label: "General Manager",
    group: "Leadership",
    tier: "full_access",
    color: "#ffd23d",
    position: 93,
    isSystem: false
  },
  {
    key: "managing_director_ceo",
    label: "Managing Director & CEO",
    group: "Leadership",
    tier: "leadership",
    color: "#ffd23d",
    position: 99,
    isSystem: false
  },
  {
    key: "vice_president_global_operations_business_development",
    label: "Vice President - Global Operations & Business Development",
    group: "Leadership",
    tier: "leadership",
    color: "#ffd23d",
    position: 95,
    isSystem: false
  },
  {
    key: "senior_producer",
    label: "Senior Producer",
    group: "Production",
    tier: "production",
    color: "#39d98a",
    position: 72,
    isSystem: false
  },
  {
    key: "producer",
    label: "Producer",
    group: "Production",
    tier: "production",
    color: "#39d98a",
    position: 68,
    isSystem: false
  },
  {
    key: "creative_producer",
    label: "Creative Producer",
    group: "Production",
    tier: "production",
    color: "#39d98a",
    position: 68,
    isSystem: false
  },
  {
    key: "senior_project_manager",
    label: "Senior Project Manager",
    group: "Production",
    tier: "production",
    color: "#39d98a",
    position: 70,
    isSystem: false
  },
  {
    key: "project_manager",
    label: "Project Manager",
    group: "Production",
    tier: "production",
    color: "#39d98a",
    position: 64,
    isSystem: false
  },
  {
    key: "associate_project_manager",
    label: "Associate Project Manager",
    group: "Production",
    tier: "production",
    color: "#39d98a",
    position: 55,
    isSystem: false
  },
  {
    key: "senior_production_coordinator",
    label: "Senior Production Coordinator",
    group: "Production",
    tier: "production",
    color: "#39d98a",
    position: 62,
    isSystem: false
  },
  {
    key: "senior_technical_artist",
    label: "Senior Technical Artist",
    group: "Engineering",
    tier: "contributor",
    color: "#4dd8d8",
    position: 50,
    isSystem: false
  },
  {
    key: "technical_artist",
    label: "Technical Artist",
    group: "Engineering",
    tier: "contributor",
    color: "#4dd8d8",
    position: 40,
    isSystem: false
  },
  {
    key: "associate_technical_artist",
    label: "Associate Technical Artist",
    group: "Engineering",
    tier: "contributor",
    color: "#4dd8d8",
    position: 30,
    isSystem: false
  },
  {
    key: "senior_unity_developer",
    label: "Senior Unity Developer",
    group: "Engineering",
    tier: "contributor",
    color: "#4dd8d8",
    position: 50,
    isSystem: false
  },
  {
    key: "unity_developer",
    label: "Unity Developer",
    group: "Engineering",
    tier: "contributor",
    color: "#4dd8d8",
    position: 40,
    isSystem: false
  },
  {
    key: "associate_unity_developer",
    label: "Associate Unity Developer",
    group: "Engineering",
    tier: "contributor",
    color: "#4dd8d8",
    position: 30,
    isSystem: false
  },
  {
    key: "game_developer",
    label: "Game Developer",
    group: "Engineering",
    tier: "contributor",
    color: "#4dd8d8",
    position: 40,
    isSystem: false
  },
  {
    key: "associate_game_developer",
    label: "Associate Game Developer",
    group: "Engineering",
    tier: "contributor",
    color: "#4dd8d8",
    position: 30,
    isSystem: false
  },
  {
    key: "test_engineer",
    label: "Test Engineer",
    group: "Engineering",
    tier: "contributor",
    color: "#4dd8d8",
    position: 40,
    isSystem: false
  },
  {
    key: "associate_test_engineer",
    label: "Associate Test Engineer",
    group: "Engineering",
    tier: "contributor",
    color: "#4dd8d8",
    position: 30,
    isSystem: false
  },
  {
    key: "trainee_test_engineer",
    label: "Trainee - Test Engineer",
    group: "Engineering",
    tier: "contributor",
    color: "#4dd8d8",
    position: 10,
    isSystem: false
  },
  {
    key: "game_mathematician",
    label: "Game Mathematician",
    group: "Game Math",
    tier: "contributor",
    color: "#9be34f",
    position: 45,
    isSystem: false
  },
  {
    key: "associate_game_mathematician",
    label: "Associate Game Mathematician",
    group: "Game Math",
    tier: "contributor",
    color: "#9be34f",
    position: 30,
    isSystem: false
  },
  {
    key: "associate_math_analyst",
    label: "Associate Math Analyst",
    group: "Game Math",
    tier: "contributor",
    color: "#9be34f",
    position: 30,
    isSystem: false
  },
  {
    key: "senior_business_development_executive",
    label: "Senior Business Development Executive",
    group: "Business & Operations",
    tier: "staff",
    color: "#8fa3c7",
    position: 60,
    isSystem: false
  },
  {
    key: "senior_operations_financial_analyst",
    label: "Senior Operations Financial Analyst",
    group: "Business & Operations",
    tier: "staff",
    color: "#8fa3c7",
    position: 55,
    isSystem: false
  },
  {
    key: "account_manager_marketing",
    label: "Account Manager - Marketing",
    group: "Business & Operations",
    tier: "full_access",
    color: "#8fa3c7",
    position: 50,
    isSystem: false
  },
  {
    key: "mis_analyst",
    label: "MIS Analyst",
    group: "Business & Operations",
    tier: "staff",
    color: "#8fa3c7",
    position: 45,
    isSystem: false
  },
  {
    key: "junior_accountant",
    label: "Junior Accountant",
    group: "Business & Operations",
    tier: "staff",
    color: "#8fa3c7",
    position: 25,
    isSystem: false
  },
  {
    key: "people_culture_partner",
    label: "People & Culture Partner",
    group: "People & Culture",
    tier: "staff",
    color: "#d49fb8",
    position: 60,
    isSystem: false
  },
  {
    key: "assistant_manager_hr_generalist",
    label: "Assistant Manager - HR Generalist",
    group: "People & Culture",
    tier: "staff",
    color: "#d49fb8",
    position: 55,
    isSystem: false
  },
  {
    key: "talent_acquisition_specialist",
    label: "Talent Acquisition Specialist",
    group: "People & Culture",
    tier: "staff",
    color: "#d49fb8",
    position: 45,
    isSystem: false
  }
];

module.exports = { ASSET_TYPES, PRIORITIES, MILESTONE_TYPES, TIMESHEET_CATEGORIES,
  TIMESHEET_SUB_OPTIONS, TIMESHEET_SUB_LABELS, ROLES };
