// Mock @azure/functions to prevent the function registration from failing in tests
jest.mock('@azure/functions', () => ({
  app: {
    serviceBusTopic: jest.fn(),
  },
}));

import { classifyIncomeTier } from '../functions/incomeClassification';
import { IncomeTier } from '../shared/types';

describe('classifyIncomeTier', () => {
  const cases: Array<[number, IncomeTier]> = [
    [0, 'Standard'],
    [50_000, 'Standard'],
    [74_999, 'Standard'],
    [75_000, 'Affluent'],
    [100_000, 'Affluent'],
    [149_999, 'Affluent'],
    [150_000, 'High Net Worth'],
    [250_000, 'High Net Worth'],
    [299_999, 'High Net Worth'],
    [300_000, 'Ultra High Net Worth'],
    [500_000, 'Ultra High Net Worth'],
    [1_000_000, 'Ultra High Net Worth'],
  ];

  test.each(cases)(
    'income $%i should be classified as "%s"',
    (income, expectedTier) => {
      expect(classifyIncomeTier(income)).toBe(expectedTier);
    },
  );
});
