-- Seed the 3 AI Studio links the user asked to keep alive 24/7.
-- interval 1 min, generous timeout. Auth redirects are treated as "up".
INSERT INTO links (name, url, interval_minutes, method, timeout_ms, headers_json, enabled)
SELECT 'AI Studio App (Preview)', 'https://aistudio.google.com/u/2/apps/3b94928e-3994-41f2-a273-353e9b1a2df0?showPreview=true', 1, 'GET', 30000, '{}', 1
WHERE NOT EXISTS (SELECT 1 FROM links WHERE url = 'https://aistudio.google.com/u/2/apps/3b94928e-3994-41f2-a273-353e9b1a2df0?showPreview=true');

INSERT INTO links (name, url, interval_minutes, method, timeout_ms, headers_json, enabled)
SELECT 'AI Studio App (Assistant)', 'https://aistudio.google.com/u/2/apps/3b94928e-3994-41f2-a273-353e9b1a2df0?showAssistant=true', 1, 'GET', 30000, '{}', 1
WHERE NOT EXISTS (SELECT 1 FROM links WHERE url = 'https://aistudio.google.com/u/2/apps/3b94928e-3994-41f2-a273-353e9b1a2df0?showAssistant=true');

INSERT INTO links (name, url, interval_minutes, method, timeout_ms, headers_json, enabled)
SELECT 'AI Studio App (Fullscreen)', 'https://ai.studio/apps/3b94928e-3994-41f2-a273-353e9b1a2df0?fullscreenApplet=true', 1, 'GET', 30000, '{}', 1
WHERE NOT EXISTS (SELECT 1 FROM links WHERE url = 'https://ai.studio/apps/3b94928e-3994-41f2-a273-353e9b1a2df0?fullscreenApplet=true');
