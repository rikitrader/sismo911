-- Muro Sísmico enhancements on the community chat: photo attachments, message
-- ownership (so a logged-in user can edit their own posts), and an edit stamp.
-- Plain ADD COLUMN (mirrors 0060_oauth) — applied once by the migrations tracker.
ALTER TABLE chat_messages ADD COLUMN image_key TEXT;   -- KV PHOTOS object key (validated image)
ALTER TABLE chat_messages ADD COLUMN user_id TEXT;     -- author user id when posted while logged in (enables edit)
ALTER TABLE chat_messages ADD COLUMN edited_ms INTEGER; -- last edit time; NULL = never edited
