-- Blog / news posts generated from the every-3h disaster-social-blog pipeline.
-- One row per AI-written field report, each derived from a REAL scraped social
-- post (caption, location, platform, engagement, source link). The dynamic
-- /blog routes render from this table so the cron can publish without a redeploy.
CREATE TABLE IF NOT EXISTS blog_posts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT NOT NULL UNIQUE,
  -- Stable id of the originating social post (platform:postId). UPSERT key →
  -- re-running the cron never duplicates a story that was already published.
  source_post_id  TEXT NOT NULL UNIQUE,
  headline        TEXT NOT NULL,
  meta_desc       TEXT NOT NULL DEFAULT '',
  body_html       TEXT NOT NULL DEFAULT '',
  place           TEXT NOT NULL DEFAULT 'Venezuela',
  lat             REAL,
  lon             REAL,
  platform        TEXT NOT NULL DEFAULT '',     -- tiktok | instagram | youtube | facebook | x
  author          TEXT NOT NULL DEFAULT '',
  source_url      TEXT NOT NULL DEFAULT '',     -- link back to the original post / story
  image_url       TEXT NOT NULL DEFAULT '',     -- poster / photo (may expire — UI has a branded fallback)
  video_url       TEXT NOT NULL DEFAULT '',     -- canonical watch URL of the source video
  video_embed_html TEXT NOT NULL DEFAULT '',    -- oEmbed/iframe markup (empty = no video)
  views           INTEGER NOT NULL DEFAULT 0,
  likes           INTEGER NOT NULL DEFAULT 0,
  comments        INTEGER NOT NULL DEFAULT 0,
  featured        INTEGER NOT NULL DEFAULT 0,    -- 1 = hero slot on the index
  status          TEXT NOT NULL DEFAULT 'published', -- published | hidden
  published_at    TEXT NOT NULL,                 -- ISO 8601
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_blog_posts_published
  ON blog_posts (status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_posts_featured
  ON blog_posts (featured DESC, published_at DESC);
