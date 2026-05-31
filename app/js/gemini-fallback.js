/**
 * Gemini Flash 폴백 — 의도 파서 confidence가 낮을 때만 호출.
 * API 키가 없으면 아무 동작 없이 null 반환 (graceful degradation).
 */
export class GeminiFallback {
  constructor() {
    this.apiKey = localStorage.getItem('gemini_api_key_router')
      || localStorage.getItem('gemini_api_key')
      || '';
    this.model = 'gemini-2.5-flash';
    this.endpoint = 'https://generativelanguage.googleapis.com/v1beta/models';
  }

  isAvailable() {
    return Boolean(this.apiKey);
  }

  setApiKey(key) {
    this.apiKey = String(key || '').trim();
    if (this.apiKey) {
      localStorage.setItem('gemini_api_key', this.apiKey);
      localStorage.setItem('gemini_api_key_router', this.apiKey);
    } else {
      localStorage.removeItem('gemini_api_key');
      localStorage.removeItem('gemini_api_key_router');
    }
  }

  /**
   * 질문에서 의도를 추출. 로컬 파서 결과를 보강/수정하는 용도.
   * @param {string} question 사용자 질문
   * @param {object} localIntent 로컬 파서 결과
   * @param {string[]} districtNames 유효 행정동 이름 목록
   * @param {string[]} industryNames 유효 업종 이름 목록
   * @returns {object|null} 보강된 intent 또는 null
   */
  async disambiguate(question, localIntent, districtNames = [], industryNames = []) {
    if (!this.isAvailable()) return null;

    const systemPrompt = `당신은 대전광역시 상권 데이터 챗봇의 의도 분석기입니다.
사용자 질문에서 다음을 추출하세요:
- district: 행정동 이름 (유효 목록에서 선택)
- industry: 업종 이름 (유효 목록에서 가장 가까운 것 선택)
- questionType: sales|upso|pop|trend|similar|overview 중 하나
- month: YYYYMM 형식 (없으면 null)

반드시 JSON만 출력하세요. 설명 없이 JSON 객체만.`;

    const userPrompt = `질문: "${question}"

로컬 파서 결과 (confidence ${localIntent.confidence}):
- district: ${localIntent.district?.name || 'null'}
- industry: ${localIntent.industry || 'null'}
- questionType: ${localIntent.questionType}

유효 행정동 (일부): ${districtNames.slice(0, 20).join(', ')}
유효 업종 (일부): ${industryNames.slice(0, 30).join(', ')}

위 로컬 결과가 틀렸다면 수정하고, 맞다면 그대로 반환하세요. JSON만 출력:`;

    try {
      const url = `${this.endpoint}/${this.model}:generateContent?key=${this.apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            { role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 256,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (!response.ok) {
        console.warn('[GeminiFallback] API error:', response.status);
        return null;
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return JSON.parse(text);
    } catch (err) {
      console.warn('[GeminiFallback] Error:', err.message);
      return null;
    }
  }
}

export default GeminiFallback;
