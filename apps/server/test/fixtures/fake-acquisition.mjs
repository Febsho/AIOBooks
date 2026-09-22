import http from "node:http";

const xml = `<?xml version="1.0"?><rss xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel><item><title>Atomic.Habits.James.Clear.English.M4B</title><guid>nzb-1</guid><link>http://fake-acquisition:4000/nzb/1</link><pubDate>Mon, 01 Sep 2025 10:00:00 GMT</pubDate><newznab:attr name="size" value="5"/><newznab:attr name="category" value="3030"/></item></channel></rss>`;
const emptyXml = `<?xml version="1.0"?><rss xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel></channel></rss>`;
const emptySearches = Math.max(0, Number.parseInt(process.env.EMPTY_SEARCHES ?? "0", 10) || 0);
let searchCount = 0;

http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fake-acquisition:4000");
  if (url.pathname === "/search.json") {
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ numFound: 1, start: 0, docs: [{ key: "/works/OL1W", title: "Atomic Habits", author_name: ["James Clear"], first_publish_year: 2018, isbn: ["9780735211292"], language: ["eng"], subject: ["Self-help"], editions: { docs: [] } }] })); return;
  }
  if (url.pathname === "/api" && url.searchParams.get("t") === "caps") {
    response.writeHead(200, { "content-type": "application/xml" }); response.end("<?xml version=\"1.0\"?><caps><searching><book-search available=\"yes\"/></searching></caps>"); return;
  }
  if (url.pathname === "/api") {
    searchCount += 1;
    response.writeHead(200, { "content-type": "application/xml" }); response.end(searchCount <= emptySearches ? emptyXml : xml); return;
  }
  if (url.pathname === "/v1/api/user/me") {
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ success: true, data: { id: 1 } })); return;
  }
  if (url.pathname === "/v1/api/usenet/createusenetdownload") {
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ success: true, data: { usenetdownloadId: 42 } })); return;
  }
  if (url.pathname === "/v1/api/usenet/mylist") {
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ success: true, data: [{ id: 42, active: false, downloadFinished: true, downloadPresent: true, progress: 1, files: [{ id: 7, shortName: "book.m4b", size: 5 }] }] })); return;
  }
  if (url.pathname === "/v1/api/usenet/requestdl") {
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ success: true, data: "http://fake-acquisition:4000/files/book.m4b" })); return;
  }
  if (url.pathname === "/files/book.m4b") {
    response.writeHead(200, { "content-type": "audio/mp4", "content-length": "5" }); response.end("audio"); return;
  }
  response.writeHead(404); response.end();
}).listen(4000, "0.0.0.0");
