
import axios from 'axios';
import env from 'dotenv';
env.config();
export const fusionConnectorConfig = {
    "tag": "latest",
    "type": "std:account:list",
    "config": {
      "clientId": process.env.SAIL_CLIENT_ID,
      "clientSecret": process.env.SAIL_CLIENT_SECRET,
      "baseurl": process.env.SAIL_BASE_URL,
      "spConnectorInstanceId": "d4ee30d5-07a8-474b-aa80-f2143551547f",
      "sources": [
        "airtable-a",
        "airtable-b"
      ],
      "cloudDisplayName": "fusion-connector",
      "merging_map": [
        {
          "identity": "email",
          "account": [
            "email",
            "Email"
          ],
          "uidOnly": true
        },
        {
          "identity": "department",
          "account": [
            "dept",
            "department"
          ],
          "uidOnly": true
        },
        {
          "identity": "displayName",
          "account": [
            "displayName"
          ],
          "uidOnly": false
        }
      ],
      "global_merging_score": true,
      "merging_score": 90,
      "merging_isEnabled": true,
      "merging_attributes": [
        "email",
        "department",
        "displayName"
      ],
      "merging_expirationDays": 5
    },
    "input": {}
  };

  
export class Configuration {
    public async getToken(tokenUrl: string, clientId: string, clientSecret: string): Promise<string> {
          const url = `${tokenUrl}`;
          const formData = new FormData()
          formData.append('grant_type', 'client_credentials')
          formData.append('client_id', clientId)
          formData.append('client_secret', clientSecret)
          return this.getAccessToken(url + '/oauth/token', formData);
    }
  
    private async getAccessToken(url: string, formData: FormData): Promise<string> {
      try {
        console.log(`attempting to fetch access token from ${url}`)
        const { data, status } = await axios.post(url, formData)
        if (status === 200) {
          return data.access_token;
        } else {
          throw new Error("Unauthorized")
        }
      } catch (error) {
        console.error("Unable to fetch access token.  Aborting.");
        throw new Error("Unauthorized")
      }
    }
  }