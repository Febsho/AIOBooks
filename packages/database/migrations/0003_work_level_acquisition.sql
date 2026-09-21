ALTER TYPE connection_kind ADD VALUE IF NOT EXISTS 'AUDIOBOOKSHELF';
ALTER TYPE connection_kind ADD VALUE IF NOT EXISTS 'FILESYSTEM';
ALTER TYPE connection_kind ADD VALUE IF NOT EXISTS 'WEBDAV';

ALTER TABLE acquisition_jobs ADD COLUMN book_id uuid REFERENCES books(id) ON DELETE RESTRICT;
UPDATE acquisition_jobs aj SET book_id = e.book_id FROM editions e WHERE e.id = aj.edition_id;
ALTER TABLE acquisition_jobs ALTER COLUMN book_id SET NOT NULL;
ALTER TABLE acquisition_jobs ALTER COLUMN edition_id DROP NOT NULL;
DROP INDEX acquisition_jobs_active_unique;
CREATE UNIQUE INDEX acquisition_jobs_active_unique
  ON acquisition_jobs(book_id, media_type, compatibility_key, COALESCE(edition_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE state NOT IN ('AVAILABLE', 'FAILED');

ALTER TABLE requests ADD COLUMN book_id uuid REFERENCES books(id) ON DELETE RESTRICT;
UPDATE requests r SET book_id = e.book_id FROM editions e WHERE e.id = r.edition_id;
ALTER TABLE requests ALTER COLUMN book_id SET NOT NULL;
ALTER TABLE requests ALTER COLUMN edition_id DROP NOT NULL;

CREATE INDEX acquisition_jobs_wanted_idx ON acquisition_jobs(next_search_at)
  WHERE state = 'WANTED';

CREATE UNIQUE INDEX authors_canonical_name_unique ON authors(lower(canonical_name));
