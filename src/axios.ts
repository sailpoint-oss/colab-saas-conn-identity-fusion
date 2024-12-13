import { IAxiosRetryConfig } from 'axios-retry'
import { REQUESTSPERSECOND, RETRIES } from './constants'
import { logger } from '@sailpoint/connector-sdk'
import { AxiosResponseHeaders } from 'axios'
import axiosRetry from 'axios-retry'

export const retriesConfig: IAxiosRetryConfig = {
    retries: RETRIES,
    retryDelay: (retryCount, error) => {
        type NewType = AxiosResponseHeaders

        const headers = error.response!.headers as NewType
        const retryAfter = headers.get('retry-after') as number

        return retryAfter ? retryAfter : 10 * 1000
    },
    retryCondition: (error) => {
        return axiosRetry.isNetworkError(error) || axiosRetry.isRetryableError(error) || error.response?.status === 429
    },
    onRetry: (retryCount, error, requestConfig) => {
        logger.debug(
            `Retrying API [${requestConfig.url}] due to request error: [${error}]. Retry number [${retryCount}]`
        )
        logger.error(error)
    },
}

export const throttleConfig = { requestsPerSecond: REQUESTSPERSECOND }
