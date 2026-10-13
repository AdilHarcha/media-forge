-- workflows d'exemple
INSERT INTO workflows (name, definition) VALUES
 ('smart-web', '{"rules":[
    {"match":{"formats":["png"]},          "resize":{"width":1600}, "convert":{"format":"webp"}, "compress":{"quality":85,"minQuality":50,"minSsim":0.97,"maxBytes":250000}},
    {"match":{"formats":["jpeg"]},         "resize":{"width":1600}, "convert":{"format":"webp"}, "compress":{"quality":85,"minQuality":50,"minSsim":0.96,"maxBytes":200000}},
    {"match":{"formats":["svg"]},          "compress":{"svgo":true}},
    {"match":{"formats":["webp","avif","gif"]}, "convert":{"format":"webp"}, "compress":{"quality":80,"minQuality":50}},
    {"match":{"kind":"video"},             "resize":{"maxHeight":1080}, "convert":{"codec":"h264"}, "compress":{"minSsim":0.97}}
  ]}'),
 ('video-web', '[{"type":"video.transcode","params":{"codec":"h264","crf":26,"maxHeight":1080}}]')
ON CONFLICT (name) DO NOTHING;
