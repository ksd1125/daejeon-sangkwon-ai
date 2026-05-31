/**
 * josa.js — 한국어 조사 자동 선택 (받침 유무 판정)
 * 사용: josa('카페', '은/는') → '는', josa('치킨', '은/는') → '은'
 * pair는 '받침형/무받침형' 순서: '은/는', '이/가', '을/를', '과/와', '으로/로', '이랑/랑'
 */
export function josa(word, pair) {
  const w = String(word ?? '').trim();
  const [withBatchim, withoutBatchim] = pair.split('/');
  if (!w) return withoutBatchim;
  const code = w.charCodeAt(w.length - 1);
  // 한글 음절(가~힣)이 아니면(숫자/영문/기호) 무받침형으로 처리
  if (code < 0xAC00 || code > 0xD7A3) return withoutBatchim;
  const jong = (code - 0xAC00) % 28; // 종성 인덱스 (0=받침없음)
  // '으로/로'는 ㄹ받침(jong===8)도 '로'를 사용
  if (pair === '으로/로' && jong === 8) return withoutBatchim;
  return jong !== 0 ? withBatchim : withoutBatchim;
}

export default josa;
