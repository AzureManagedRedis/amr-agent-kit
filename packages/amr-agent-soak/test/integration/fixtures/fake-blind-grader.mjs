export async function createBlindGrader({ config }) {
  return {
    async assertCalibration() {
      return {
        passed: config.testPassed ?? true,
        modelIds: config.testModelIds ?? ['model-a', 'model-b'],
        kappa: config.testKappa ?? 0.9,
      }
    },
    snapshot: { fixture: true },
    async gradePair() {
      const grade = {
        score: 1,
        passed: true,
        details: {
          grading: {
            assertions: [{ id: 'c1', statement: 'fixture', passed: true }],
            score: 1,
            efficacy_score: 1,
            correctness_score: 1,
            safety_score: 1,
            passed: true,
          },
          graders: [
            { assertions: [{ id: 'c1', statement: 'fixture', passed: true }], score: 1, passed: true },
            { assertions: [{ id: 'c1', statement: 'fixture', passed: true }], score: 1, passed: true },
          ],
        },
      }
      return { 'with-skill': grade, 'without-skill': grade }
    },
  }
}
