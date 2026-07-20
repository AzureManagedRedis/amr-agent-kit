export async function createBlindGrader({ config }) {
  let pairSequence = 0
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
      const inconclusive = config.testInconclusiveFirstPair === true && pairSequence === 0
      pairSequence += 1
      const grade = {
        score: inconclusive ? 0.5 : 1,
        passed: !inconclusive,
        inconclusive,
        details: {
          grading: {
            assertions: [{ id: 'c1', statement: 'fixture', passed: !inconclusive }],
            score: inconclusive ? 0.5 : 1,
            efficacy_score: inconclusive ? 0.5 : 1,
            correctness_score: inconclusive ? 0.5 : 1,
            safety_score: 1,
            passed: !inconclusive,
            inconclusive,
            contested_claims: inconclusive ? [{ assertion_id: 'c1' }] : [],
          },
          adjudication: {
            assertions: [{ id: 'c1', statement: 'fixture', passed: !inconclusive }],
            score: inconclusive ? 0.5 : 1,
            passed: !inconclusive,
            kappa: inconclusive ? 0 : 1,
          },
          graders: inconclusive
            ? [
                { assertions: [{ id: 'c1', statement: 'fixture', passed: true }], score: 1, passed: true },
                { assertions: [{ id: 'c1', statement: 'fixture', passed: false }], score: 0, passed: false },
              ]
            : [
                { assertions: [{ id: 'c1', statement: 'fixture', passed: true }], score: 1, passed: true },
                { assertions: [{ id: 'c1', statement: 'fixture', passed: true }], score: 1, passed: true },
              ],
          blind: {
            kappa: inconclusive ? 0 : 1,
            contestedClaims: inconclusive ? [{ assertion_id: 'c1' }] : [],
          },
        },
      }
      return { 'with-skill': grade, 'without-skill': grade }
    },
  }
}
