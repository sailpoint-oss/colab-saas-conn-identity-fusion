import axios from 'axios';
import env from 'dotenv';
import { fusionConnectorConfig, Configuration } from './test-config';
import { fail } from 'assert';
env.config();

describe('API Integration Tests', () => {
  let token: string;

  beforeAll(async () => {
    const config = new Configuration();
    token = await config.getToken(process.env.SAIL_BASE_URL!, process.env.SAIL_CLIENT_ID!, process.env.SAIL_CLIENT_SECRET!);
  });

  afterAll(async () => {
    // Clean up code if needed
  });

  it('should invoke the fusion connector', async () => {
    const data = JSON.stringify(fusionConnectorConfig);
    

    const config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: `${process.env.SAIL_BASE_URL}/v2024/platform-connectors/${process.env.STACK}/invoke`,
      headers: { 
        'Content-Type': 'application/json', 
        'Accept': 'application/json', 
        'X-SailPoint-Experimental': 'true', 
        'Authorization': `Bearer ${token}`
      },
      data: data
    };

    try {
      const response = await axios.request(config);
      expect(response.status).toBe(200); 
      expect(response.data).toBeDefined();
    } catch (error) {
      fail(`API call failed: ${error}`);
    }
  });
});

