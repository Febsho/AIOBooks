import type { BookWork, ExternalIdentifier } from "@aiobooks/core";
import type { Database } from "./database.js";

function normalizedIdentifier(identifier: ExternalIdentifier): string {
  return identifier.value.replace(/[^a-zA-Z0-9]/g, "").toLocaleUpperCase("en");
}

function providerIdentity(work: BookWork): { provider: string; externalId: string } {
  const openLibrary = work.identifiers.find((identifier) => identifier.type === "OPEN_LIBRARY")?.value;
  if (!openLibrary) throw new Error("Metadata work has no supported provider identifier");
  return { provider: "openlibrary", externalId: openLibrary };
}

export async function persistMetadataWorks(sql: Database, works: BookWork[]): Promise<BookWork[]> {
  const persisted: BookWork[] = [];
  for (const work of works) {
    const identity = providerIdentity(work);
    const [book] = await sql<{ id: string }[]>`
      INSERT INTO books (title, subtitle, description, first_published_year, cover_url, series_name, series_position, genres, metadata_provider, metadata_provider_id)
      VALUES (${work.title}, ${work.subtitle ?? null}, ${work.description ?? null}, ${work.firstPublishedYear ?? null}, ${work.coverUrl ?? null}, ${work.series?.name ?? null}, ${work.series?.position ?? null}, ${sql.json(work.genres)}, ${identity.provider}, ${identity.externalId})
      ON CONFLICT (metadata_provider, metadata_provider_id) DO UPDATE SET
        title = EXCLUDED.title, subtitle = EXCLUDED.subtitle, description = COALESCE(EXCLUDED.description, books.description),
        first_published_year = EXCLUDED.first_published_year, cover_url = EXCLUDED.cover_url, genres = EXCLUDED.genres,
        metadata_updated_at = now(), updated_at = now()
      RETURNING id
    `;
    const bookId = book!.id;
    for (const [position, author] of work.authors.entries()) {
      await sql`INSERT INTO authors (canonical_name) VALUES (${author.name}) ON CONFLICT DO NOTHING`;
      const [storedAuthor] = await sql<{ id: string }[]>`SELECT id FROM authors WHERE lower(canonical_name) = lower(${author.name}) LIMIT 1`;
      if (storedAuthor) await sql`INSERT INTO book_authors (book_id, author_id, position) VALUES (${bookId}, ${storedAuthor.id}, ${position}) ON CONFLICT DO NOTHING`;
    }
    for (const identifier of work.identifiers) {
      await sql`
        INSERT INTO identifiers (book_id, type, value, normalized_value)
        VALUES (${bookId}, ${identifier.type}, ${identifier.value}, ${normalizedIdentifier(identifier)})
        ON CONFLICT DO NOTHING
      `;
    }
    const editions = [];
    for (const edition of work.editions) {
      const external = edition.identifiers.find((identifier) => identifier.type === "OPEN_LIBRARY")?.value;
      if (!external) continue;
      const [storedEdition] = await sql<{ id: string }[]>`
        INSERT INTO editions (book_id, title, subtitle, publisher, published_at, languages, media_types, duration_seconds, metadata_provider, metadata_provider_id)
        VALUES (${bookId}, ${edition.title}, ${edition.subtitle ?? null}, ${edition.publisher ?? null}, ${edition.publishedAt ?? null}, ${edition.languages}, ${edition.mediaTypes}, ${edition.durationSeconds ?? null}, 'openlibrary', ${external})
        ON CONFLICT (metadata_provider, metadata_provider_id) DO UPDATE SET
          title = EXCLUDED.title, subtitle = EXCLUDED.subtitle, publisher = EXCLUDED.publisher, published_at = EXCLUDED.published_at,
          languages = EXCLUDED.languages, media_types = EXCLUDED.media_types, updated_at = now()
        RETURNING id
      `;
      const editionId = storedEdition!.id;
      for (const identifier of edition.identifiers) {
        await sql`
          INSERT INTO identifiers (edition_id, type, value, normalized_value)
          VALUES (${editionId}, ${identifier.type}, ${identifier.value}, ${normalizedIdentifier(identifier)})
          ON CONFLICT DO NOTHING
        `;
      }
      editions.push({ ...edition, id: editionId, workId: bookId });
    }
    persisted.push({ ...work, id: bookId, editions });
  }
  return persisted;
}

export async function loadBookWork(sql: Database, bookId: string): Promise<BookWork | null> {
  const books = await sql<{
    id: string; title: string; subtitle: string | null; description: string | null; first_published_year: number | null; cover_url: string | null; series_name: string | null; series_position: string | null; genres: string[];
  }[]>`SELECT id, title, subtitle, description, first_published_year, cover_url, series_name, series_position, genres FROM books WHERE id = ${bookId}`;
  const book = books[0];
  if (!book) return null;
  const authors = await sql<{ id: string; canonical_name: string }[]>`
    SELECT a.id, a.canonical_name FROM authors a JOIN book_authors ba ON ba.author_id = a.id WHERE ba.book_id = ${bookId} ORDER BY ba.position
  `;
  const identifiers = await sql<{ type: ExternalIdentifier["type"]; value: string }[]>`SELECT type, value FROM identifiers WHERE book_id = ${bookId}`;
  return {
    id: book.id, title: book.title, authors: authors.map((author) => ({ id: author.id, name: author.canonical_name })), genres: book.genres, identifiers, editions: [],
    ...(book.subtitle ? { subtitle: book.subtitle } : {}), ...(book.description ? { description: book.description } : {}),
    ...(book.first_published_year ? { firstPublishedYear: book.first_published_year } : {}), ...(book.cover_url ? { coverUrl: book.cover_url } : {}),
    ...(book.series_name ? { series: { name: book.series_name, ...(book.series_position ? { position: Number(book.series_position) } : {}) } } : {}),
  };
}
