-- Невидимые символы в текстах клубов (DEV-77): U+200B, U+2060, U+FEFF
-- приходили копированием из 2ГИС. Новые срезает пайп проверки входа,
-- здесь чистятся уже сохранённые строки.
UPDATE "Club"
SET "name" = regexp_replace("name", E'[​⁠﻿]', '', 'g'),
    "shortName" = regexp_replace("shortName", E'[​⁠﻿]', '', 'g'),
    "address" = btrim(regexp_replace("address", E'[​⁠﻿]', '', 'g'))
WHERE "name" ~ E'[​⁠﻿]'
   OR "shortName" ~ E'[​⁠﻿]'
   OR "address" ~ E'[​⁠﻿]';
