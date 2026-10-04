// Public settings. The key below is Supabase's publishable key: it is safe to ship
// in the browser because the database only lets it call the footy_* functions.
export const SUPABASE_URL = 'https://xzcnwqvynjainrnlyodo.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_amLZxJuWCswM5hWyeG7mZA_fxMhbMHk';

// All times are shown in this time zone, wherever the viewer is.
export const TIMEZONE = 'America/Toronto';

// Prefilled when an organizer schedules the very first game.
export const DEFAULT_GAME = {
  title: '8 v 8',
  venue: 'BMO Centre Fields',
  field: '',
  weekday: 0,          // 0 = Sunday
  start: '20:45',
  end: '22:00',
  price: '11.30',
  capacity: 18,        // 2 teams of 8 + 1 sub each
  team_count: 2,
  pay_by_hours: 24,
};
