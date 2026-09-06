-- 010: 디노 통합 DB 의 카테고리 표기를 표준으로 잇는다
--
-- 002 가 momcal·pangpang·ingong 표기만 넣어 뒀는데, 실제로 올리는 파일은 세
-- 사이트를 합친 '디노 통합 DB' 다. 그 파일의 표기가 하나도 매핑되지 않아
-- 적합도의 카테고리 20점이 전원 0 이 됐다 — 화면에는 아무 표시도 나지 않고
-- 순위만 이상해진다.
--
-- 표준은 score.ADJACENT 의 키와 같아야 한다:
--   리빙 · 인테리어 · 가전 · 육아 · 식품 · 건강 · 뷰티 · 패션 · 여행 · 반려동물
-- 여기 없는 표준을 쓰면 인접 카테고리 12점도 같이 죽는다.
--
-- '기타' · '일상' · '지역' 은 일부러 넣지 않는다. 무엇이든 될 수 있는 말이라
-- 아무 카테고리로도 보내면 안 된다 — 매핑이 없으면 점수에 반영되지 않고 끝난다.

INSERT INTO category_map (source, source_category, canonical) VALUES
 ('dino','뷰티','뷰티'),
 ('dino','육아','육아'),
 ('dino','음식','식품'),
 ('dino','맛집','식품'),
 ('dino','식품','식품'),
 ('dino','식품요리','식품'),
 ('dino','키즈푸드','육아'),
 ('dino','장보기','식품'),
 ('dino','생활용품','리빙'),
 ('dino','살림생활','리빙'),
 ('dino','생활','리빙'),
 ('dino','주방','리빙'),
 ('dino','청소','리빙'),
 ('dino','리빙','리빙'),
 ('dino','인테리어','인테리어'),
 ('dino','가구','인테리어'),
 ('dino','가전','가전'),
 ('dino','테크','가전'),
 ('dino','it','가전'),
 ('dino','패션','패션'),
 ('dino','건강','건강'),
 ('dino','다이어트','건강'),
 ('dino','다이어트건강','건강'),
 ('dino','약사전문','건강'),
 ('dino','스포츠','건강'),
 ('dino','여행','여행'),
 ('dino','여행캠핑','여행'),
 ('dino','숙소','여행'),
 ('dino','반려동물','반려동물'),
 ('dino','키즈용품','육아'),
 ('dino','키카','육아'),
 ('dino','체험','육아'),
 ('dino','교육','육아')
ON CONFLICT (source, source_category) DO NOTHING;

-- 우리 양식(직접 작성)도 같은 말을 쓴다. 딜 CSV 의 카테고리 칸이 여기로 온다.
INSERT INTO category_map (source, source_category, canonical)
SELECT 'manual', source_category, canonical FROM category_map WHERE source = 'dino'
ON CONFLICT (source, source_category) DO NOTHING;

-- 표준 이름 자체도 넣어 둔다. 이미 표준으로 적어 온 파일이 매핑에 걸리지 않아
-- 애매 표기로 취급되는 일을 막는다.
INSERT INTO category_map (source, source_category, canonical)
SELECT src, c, c
  FROM unnest(ARRAY['dino','manual','momcal','pangpang','ingong']) AS src,
       unnest(ARRAY['리빙','인테리어','가전','육아','식품','건강','뷰티','패션','여행','반려동물']) AS c
ON CONFLICT (source, source_category) DO NOTHING;
