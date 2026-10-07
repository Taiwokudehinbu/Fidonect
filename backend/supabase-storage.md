# Avatars storage setup (dashboard only, ~3 min, no SQL)

1. Supabase dashboard > Storage > New bucket:
   - Name: `avatars`
   - Public: ON (photos display to other students) > Save.
2. Table Editor > `profiles` > + in the column header > add `photo_url`,
   type text, nullable > Save.
3. Storage > `avatars` bucket > Policies > New policy > Create from scratch:
   - Name: `upload own avatars`
   - Allowed operation: INSERT, target role: authenticated
   - WITH CHECK expression: `true` > Save.
   (MVP-simple: any logged-in user may write this bucket. Photos are
   public-viewable by design; tighten to per-user folders pre-launch.)
4. Reads need no policy (public bucket).

Test: log in on the page > choose a JPG/PNG under 2MB > Upload photo.
