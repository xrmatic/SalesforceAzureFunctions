import { axiosWithRetry, MAX_RETRY_ATTEMPTS } from '../shared/retry';

// Mock axios so we don't make real HTTP calls
jest.mock('axios');
import axios from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

const silentContext = {
  log: jest.fn(),
  error: jest.fn(),
};

describe('axiosWithRetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Force Math.random to return 0 so all backoff delays are 0 ms
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the response on a successful first attempt', async () => {
    const mockResponse = { data: { result: 'ok' }, status: 200 };
    mockedAxios.request = jest.fn().mockResolvedValueOnce(mockResponse);

    const result = await axiosWithRetry({ method: 'GET', url: 'https://example.com' }, silentContext);
    expect(result.data).toEqual({ result: 'ok' });
    expect(mockedAxios.request).toHaveBeenCalledTimes(1);
  });

  it(`throws after ${MAX_RETRY_ATTEMPTS} attempts on a 503 error`, async () => {
    const networkError = Object.assign(new Error('Service Unavailable'), {
      isAxiosError: true,
      response: { status: 503 },
      code: undefined,
    });

    mockedAxios.request = jest.fn().mockRejectedValue(networkError);

    await expect(
      axiosWithRetry({ method: 'GET', url: 'https://example.com' }, silentContext),
    ).rejects.toMatchObject({ message: 'Service Unavailable' });

    expect(mockedAxios.request).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS);
  });

  it('does not retry on a 400 Bad Request error', async () => {
    const clientError = Object.assign(new Error('Bad Request'), {
      isAxiosError: true,
      response: { status: 400 },
      code: undefined,
    });

    mockedAxios.request = jest.fn().mockRejectedValue(clientError);

    await expect(
      axiosWithRetry({ method: 'GET', url: 'https://example.com' }, silentContext),
    ).rejects.toMatchObject({ message: 'Bad Request' });

    // Should only be called once – no retries for 400
    expect(mockedAxios.request).toHaveBeenCalledTimes(1);
  });
});

