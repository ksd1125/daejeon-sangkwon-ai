/**
 * tool-definitions.js — Gemini Function Calling 도구 선언
 * 5개 도구: 행정동+업종 분석, 현황 종합, 비교, 유사 상권, 합산
 */

export const TOOL_DECLARATIONS = [
  {
    name: 'analyzeDistrictIndustry',
    description: '특정 행정동의 특정 업종에 대한 매출, 업소 수, 유동인구, 추세 등을 분석합니다. 사용자가 지역과 업종을 모두 언급한 경우 사용합니다.',
    parameters: {
      type: 'OBJECT',
      properties: {
        district: {
          type: 'STRING',
          description: '행정동 이름 (예: 둔산1동, 중앙동, 노은1동)',
        },
        industry: {
          type: 'STRING',
          description: '업종명 (예: 카페, 편의점, 치킨, 한식, 미용실)',
        },
        metric: {
          type: 'STRING',
          enum: ['sales', 'stores', 'population', 'trend', 'all'],
          description: '조회할 지표. sales=매출, stores=업소 수, population=유동인구, trend=추세, all=주요 지표 모두. 기본값 all.',
        },
      },
      required: ['district', 'industry'],
    },
  },
  {
    name: 'getDistrictOverview',
    description: '행정동의 전체 상권 현황을 조회합니다. 업종을 모르거나 "어때?", "현황", "종합" 같은 넓은 질문에 사용합니다.',
    parameters: {
      type: 'OBJECT',
      properties: {
        district: {
          type: 'STRING',
          description: '행정동 이름 (예: 중앙동, 둔산1동)',
        },
      },
      required: ['district'],
    },
  },
  {
    name: 'compareDistricts',
    description: '두 행정동의 같은 업종을 비교합니다. "A동이랑 B동 비교", "A vs B" 같은 질문에 사용합니다.',
    parameters: {
      type: 'OBJECT',
      properties: {
        district1: {
          type: 'STRING',
          description: '첫 번째 행정동 이름',
        },
        district2: {
          type: 'STRING',
          description: '두 번째 행정동 이름',
        },
        industry: {
          type: 'STRING',
          description: '비교할 업종명',
        },
      },
      required: ['district1', 'district2', 'industry'],
    },
  },
  {
    name: 'findSimilarDistricts',
    description: '특정 행정동+업종과 유사한 상권을 찾습니다. "비슷한 곳", "유사 상권" 같은 질문에 사용합니다.',
    parameters: {
      type: 'OBJECT',
      properties: {
        district: {
          type: 'STRING',
          description: '기준 행정동 이름',
        },
        industry: {
          type: 'STRING',
          description: '기준 업종명',
        },
      },
      required: ['district', 'industry'],
    },
  },
  {
    name: 'mergeDistricts',
    description: '여러 행정동의 데이터를 합산하여 분석합니다. "A동+B동 합쳐서", "두 동 합산" 같은 질문에 사용합니다.',
    parameters: {
      type: 'OBJECT',
      properties: {
        districts: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: '합산할 행정동 이름 목록 (2개 이상)',
        },
        industry: {
          type: 'STRING',
          description: '업종명',
        },
      },
      required: ['districts', 'industry'],
    },
  },
  {
    name: 'compareIndustries',
    description: '같은 행정동 안에서 2~3개 업종을 비교합니다. "카페 vs 치킨", "편의점이랑 미용실 비교" 같은 질문에 사용합니다.',
    parameters: {
      type: 'OBJECT',
      properties: {
        district: {
          type: 'STRING',
          description: '행정동 이름 (예: 둔산1동, 중앙동)',
        },
        industries: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: '비교할 업종 목록 (2~3개, 예: ["카페", "치킨", "편의점"])',
        },
        metric: {
          type: 'STRING',
          enum: ['sales', 'stores', 'population'],
          description: '비교 기준. sales=매출, stores=업소 수, population=유동인구. 기본값 sales.',
        },
      },
      required: ['district', 'industries'],
    },
  },
  {
    name: 'rankDistrictsByIndustry',
    description: '특정 구 안에서 특정 업종의 매출, 업소 수, 유동인구가 높은 행정동 순위를 조회합니다. 예: "유성구 내 카페 매출이 높은 행정동", "서구 치킨 업소 수 상위 동".',
    parameters: {
      type: 'OBJECT',
      properties: {
        sgg: {
          type: 'STRING',
          description: '시군구 이름 (예: 유성구, 서구, 중구, 동구, 대덕구)',
        },
        industry: {
          type: 'STRING',
          description: '업종명 (예: 카페, 편의점, 치킨, 한식, 미용실)',
        },
        metric: {
          type: 'STRING',
          enum: ['sales', 'stores', 'population'],
          description: '순위 기준. sales=매출, stores=업소 수, population=유동인구. 기본값 sales.',
        },
        limit: {
          type: 'NUMBER',
          description: '상위 몇 개를 볼지. 기본값 10.',
        },
      },
      required: ['sgg', 'industry'],
    },
  },
  {
    name: 'analyzeSggIndustry',
    description: '특정 구 전체에서 특정 업종의 현황과 최근 추세를 조회합니다. 매출 추세는 구 평균뿐 아니라 최근 12개월 평균 업소당 월매출 기준 상위 10%/하위 10% 행정동 비교군을 함께 제공합니다. 예: "유성구 편의점 최근 추세", "서구 카페 현황", "중구 편의점 매출 추이".',
    parameters: {
      type: 'OBJECT',
      properties: {
        sgg: {
          type: 'STRING',
          description: '시군구 이름 (예: 유성구, 서구, 중구, 동구, 대덕구)',
        },
        industry: {
          type: 'STRING',
          description: '업종명 (예: 편의점, 카페, 치킨, 한식)',
        },
        metric: {
          type: 'STRING',
          enum: ['sales', 'stores', 'population', 'trend', 'all'],
          description: '조회 지표. sales=매출, stores=업소 수, population=유동인구, trend=최근 추세, all=종합. 기본값 trend.',
        },
      },
      required: ['sgg', 'industry'],
    },
  },
];
