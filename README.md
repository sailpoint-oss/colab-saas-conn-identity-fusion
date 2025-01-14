[![Discourse Topics][discourse-shield]][discourse-url]
[![Issues][issues-shield]][issues-url]
[![Latest Releases][release-shield]][release-url]
[![Contributor Shield][contributor-shield]][contributors-url]

[discourse-shield]: https://img.shields.io/discourse/topics?label=Discuss%20This%20Tool&server=https%3A%2F%2Fdeveloper.sailpoint.com%2Fdiscuss
[discourse-url]: https://developer.sailpoint.com/discuss/tag/workflows
[issues-shield]: https://img.shields.io/github/issues/sailpoint-oss/repo-template?label=Issues
[issues-url]: https://github.com/sailpoint-oss/repo-template/issues
[release-shield]: https://img.shields.io/github/v/release/sailpoint-oss/repo-template?label=Current%20Release
[release-url]: https://github.com/sailpoint-oss/repo-template/releases
[contributor-shield]: https://img.shields.io/github/contributors/sailpoint-oss/repo-template?label=Contributors
[contributors-url]: https://github.com/sailpoint-oss/repo-template/graphs/contributors

# Identity Fusion SaaS Connector

[Explore the docs »](https://developer.sailpoint.com/discuss/t/identity-fusion-connector/38793)

[New to the CoLab? Click here »](https://developer.sailpoint.com/discuss/t/about-the-sailpoint-developer-community-colab/11230)

## Changelog

-   0.0.3 (2024-04-03):
    -   Updated sailpoint-api-client to v1.3.2
    -   Added keepalive messages to account aggregation process
-   0.0.2 (2024-04-02):
    -   Initial public release

## Identity Fusion SaaS Connector 

There are two common challenges Identity Security Cloud (ISC) admins and source admins face when they aggregate identity data: 

1. ISC doesn't have a built-in mechanism to generate unique identifiers for identities and handle value collision. There are ways to resolve this issue, but they are complex and may require the use of external systems, which you must then maintain. 

2. ISC's typical correlation process, which involves finding an identical match based on various identity attributes, can fail and generate duplicated identities when the data isn't 100% accurate, which isn't uncommon. 

The Identity Fusion SaaS Connector solves both these problems: 

- To solve the first, the connector provides an identifer template you can use to configure the generation of unique identifiers and handle value collision. 

- To solve the second, the connector provides a duplication check you can use to review identities and prevent their duplication in ISC. The connector also provides an account merging configuration that controls how it merges account attributes from different schemas and maps the account attributes to identity attributes. 

You can use these features independently or together. 

## Unique ID creation

The fusion connector provides a template you can use to configure the generation of unique identifiers. This template offers you a simple way to configure typical string manipulation options, like normalizing special characters and removing spaces, within ISC. This template is based on Velocity for flexibility and standardization, including the placement of the disambiguation counter. 

![Unique identifier configuration options](assets/images/unique-id-configuration.png)

In addition to the template-based unique identifier, the connector assigns an immutable Universally Unique Identifier (UUID) to the account, which you can synchronize with all the identity's accounts. 

https://github.com/sailpoint-oss/colab-saas-conn-identity-fusion/assets/64795004/0533792f-7f12-42a9-93d2-bb519260f0b4

This UUID also supports reevaluation, which may be necessary when infrequent changes occur, such as a surname change, which would make the previous value incorrect.

## Deduplication  

The fusion connector provides a similarity check that prevents the duplication of identities. 

![Deduplication configuration](assets/images/deduplication-configuration.png)

The connector checks new accounts for similarity and if it determines the accounts are similar to one or more identities (based on a minimum similarity score), it submits the accounts for manual review to configured reviewers. The fusion connector's source is authoritative, so when it processes accounts that don't have similar existing identities, it generates new ones. 

In addition to this deduplication process, you can still use conventional correlation from the original account sources. This makes the process very flexible. 

## Mapping and merging accounts

When the fusion connector is deduplicating identities, it generates proxy accounts that result from merging account data from multiple sources. Sources may present different account schemas, so the connector can discover the account schema that results from combining the configured sources' schemas. The account merging configuration controls how account attributes map to identity attributes for comparison and also how to handle multiple accounts contributing to the same attribute. 

![Base configuration](assets/images/base-configuration.png)

Because the connector is comparing new accounts from multiple sources with existing identities, you must map account attributes to identity attributes, which results in a combined schema from all configured sources, as well as a series of normalized attributes. 

When multiple source accounts contribute to a proxy account, there may be multiple values for the same attribute. The connector allows you to keep all values or only one. 

![Configuration can be general or per attribute](assets/images/attribute-configuration.png)

Keeping all values for an attribute can be useful in situations where multiple accounts can contribute to an identity attribute, like multiple job descriptions for the same person. You can then use these values in role assignments or searches. 

![The result is both values concatenated with square brackets](assets/images/attribute-merging.png) 

## Connector modes

When you're configuring the fusion connector, you must first decide whether you want it to be an authoritative or regular source: 

- **Authoritative source**: An authoritative source is an organization's primary source, providing a complete list of its identities, like an HR application or Active Directory. To use deduplication, you must configure the fusion connector as an authoritative source because it's reading all the identities from a list of sources that may otherwise be authoritative sources themselves. When the connector merges account data, it creates proxy accounts, so the original accounts are not necessary to build the identity profile. The proxy accounts directly provide all account attribute data. 

- **Regular source**: If you only need to generate unique identifiers and you aren't worried about duplication, you can configure the fusion connector as a regular source. When you're using the connector as a regular source, the connector uses the identifiers associated with the identity profiles linked to the sources included in the connector's configuration. When you use the connector as a regular source, you must ensure the following: 

    - All sources for the identity profiles you want to generate unique identifiers for are included in the list.

    - The 'Include existing identities' option is enabled.

    - The unique ID scope is set to 'Source'.

    - The attributes the Velocity template is using either exist in the account schema or are mapped identity attributes. 

Whether you use the fusion connector as an authoritative or regular source, the connector generates proxy accounts based on the configured sources and the the connector's other configuration options. These proxy accounts are the result of merging all source account attributes, normalized attributes based on the connector's configuration, and this set of mandatory attributes: 

- **id**: The template-based unique identifier.

- **uuid**: The immutable Universally Unique Identifier (UUID).

- **accounts**: The list of source accounts IDs linked to the proxy account.

- **history**: The chronological history of operations performed on the account.

- **status**: The list of entitlements used as tags to identify the account's origin. (?)

- **reviews**: The list of pending form instances a reviewer must attend to.

![Account attributes](assets/images/account-attributes.png)

## Identifier creation 

The fusion connector's identifier creation process occurs during account aggregation. When the connector creates the identifiers, the aggregation context prevents race conditions, errors that occur when multiple processes try to access the same resource at the same time. The connector reads previously aggregated accounts and compares these existing accounts to the current list to detect accounts that haven't been processed yet. 

Because the connector is deciding whether to create new accounts or update existing ones, each run starts by processing completed form instances generated by previous runs. With each run, the connector updates proxy accounts with data resulting from deduplication actions, as well as new sourec account data. 

## Deduplication process

When the fusion connector finds a potential match, based on an attribute similarity check, it generates form instances for reviewers to check. ISC sends the reviewer an email, prompting him or her to check for a potential identity merge. 

![Email is sent to reviewer](assets/images/email.png)

The first reviewer to complete the form decides what to do with the account: create a new identity or link it to an existing one. 

![Deduplication form](assets/images/form.png)

Once the reviewer makes a decision, the connector either correlates the new account with an existing identity or creates a new one, and it updates the account's history accordingly. 

![New account is correlated and history updated accordingly](assets/images/new-account.png)

## Account aggregation 

When you run an account aggregation for the first time, the fusion connector creates an account baseline. This baseline doesn't affect the creation of unique identifiers, which are always unique regardless of the batch they're created on, but it is essential for deduplication, which requires a list of identities to compare incoming account data to. You can add more sources to the configuration, and account data from those sources will be compared with this baseline. 

When the connector creates new proxy accounts, it returns them as 'disabled'. They're disabled because the connector is an authoritative source, so it creates new identities for new accounts, which means that the identities don't exist yet and cannot yet be correlated. Disabling allows you to quickly correlate the proxy accounts with their source accounts. The best practice is to configure the identity profile so it automatically enables proxy accounts, triggering correlation with their source accounts. Alternatively, the next account aggregation will run pending account correlations. 

Disabling an account triggers a template-based unique identifier reevaluation. It is recommended that you configure UUID as the account's native identity and name. UUID works well as a native identity because native identities cannot be changed, and it works well as a name because the account name must not change if you want to keep the identity. 

:::note

You can reenable or reaggregate a disabled account so it appears enabled. 

:::

## Entitlement aggregation

When you run an entitlement aggregation, the fusion connector connector populates all the different statuses with descriptions.

![Entitlements are simply tags for accounts](assets/images/entitlements.png)

The connector supports discovering the schema. The connector builds this schema by merging the multiple configured sources' schemas, normalized attributes based on the configuration, and some predefined attributes. Depending on the attribute merge configuration, the connector may return some attributes as multi-valued entitlements. If you are changing the attribute merge settings and your changes may result in changes to multi-valued attributes after the first schema discovery, you must review your schema and change it accordingly (ISC doesn't do this for you). You can also remove optional schema attributes to prevent the connector from fetching undesired data. 

## API configuration 

To start configuring the fusion connector, you must first configure the connector to be able to use the APIs. 

![API configuration](assets/images/api-configuration.png)

- **IdentityNow API URL**: The current tenant's API URL. The connector uses this for loopback connection. 

- **Personal Access Token ID**: The personal access token ID with the 'scopes:all' scope. 

- **Personal Access Token Secret**: The personal access token's secret. 

All these values are required. 

## Base configuration 

The next step to configuring the fusion connector is setting up the base configuration. This base configuration controls details like which sources the connector should read and how to handle the account data it finds. 

![Base configuration](assets/images/base-configuration2.png)

- **List of account sources to read from**: The list of authoritative sources to read from.

- **Default attribute merge from multiple sources**: This determines how the connector handles the account data it finds. 

    -   **First found**: The connector uses the first value found for an account, based on the set source order, to populate the account attribute.

    -   **Make multi-valued entitlement**: The connector creates a list of unique values from all accounts contributing to the account attribute.

    -   **Concatenate values**: The connector creates a concatenated string of unique values, enclosed in square brackets, from all accounts contributing to the same account attribute.

- **Include existing identities?**: This determines whether the connector includes existing identities from the source list. If the connector doesn't include existing identities, it ignores correlated accounts from the source list. When the connector includes them, it processes the existing identities too, but those identities' UIDs are considered their unique IDs. 

- **Delete accounts with no authoritative accounts left?**: This determines whether the connector deletes the proxy account when there are no linked accounts left. 

- **Reset accounts?**: The convenience option to reset current accounts from the source.

## Unique ID configuration 

The next step to configuring the fusion connector is setting up its unique ID configuration, which determines how the connector generates unique IDs. 

![UniqueID configuration](assets/images/unique-id-configuration2.png)

- **Unique ID scope**: These options determine whether the connector includes only source accounts or includes both source accounts and all identities when it calculates unique identifiers. 

    - **Source**: The connector only consider source accounts when it calculates unique identifiers.

    - **Platform**: The connector considers both source accounts IDs and all identities' UIDs when it calculates unique identifiers.

- **Apache Velocity template**: The connector uses this template to generate unique identifiers. The Apache Velocity context is based on the account attributes. It is best to use normalized attributes, defined in the next section.

- **Normalize special characters?**: Remove special characters and quotes.

- **Maximum counter digits**: Zero-based padding added to disambiguation counter.

- **Case selection**: These options control how the connector handles casing differences. 

    - **Do not change**: Do nothing.

    - **Lower case**: Change the string to lower case.

    - **Upper case**: Change the string to upper case.

## Deduplication Configuration

![Deduplication configuration](assets/images/deduplication-configuration2.png)

If you want to use deduplication, the next step to configuring the fusion connector is setting up the deduplication check and review process. 

-   **List of identity attributes to include in form**: The list of identity attributes to include in the deduplication form.

-   **Manual reviewer identity or governance group**: The UID of the reviewer or the governance group name.

-   **Manual review expiration days**: The number of days until the form instance expires.

-   **Minimum similarity score [0-100] (LIG3 similarity function \* 100 from Levenshtein distance)**: The similarity score to apply attribute by attribute. 0 is totally different and 100 is exactly the same. 

## Attribute Mapping 

When you aggregate account data from the different sources, they will often be stored in different formats than your identity data in ISC. To standardize the attribute data between identities and their correlated source accounts, you must configure how the connector maps account attributes with identity attributes. 

![Attribute mapping](assets/images/attribute-mapping.png)

-   **Identity attribute**: Identity attribute to compare the account attribute with. The connector also adds this attribute to the proxy account schema and populates it with the account attributes. 

-   **Account attributes**: Account attributes to compare with the identity attribute.

-   **Use mapping for unique ID generation only**: When this option is checked, the account attribute mapping occurs and the connector uses mapping to generate unique IDs, but it does not use this configuration for similarity matching.

## Attribute Merging 

With the fusion connector, you can merge account attributes from different sources. You can configure how the connector merges account attributes in this section. 

![Attribute merging](assets/images/attribute-merging2.png)

-   **First found**: Use the first value found for the account, based on the set source order, to populate the attribute.

-   **Make multi-valued entitlement**: Create a list of unique values from all accounts contributing to the attribute.

-   **Concatenate values**: Create a concatenated string of unique values, enclosed in square brackets, from all accounts contributing to the attribute.

-   **Source**: The name of the only source contributing to the attribute.

### Correlation

The fusion connector's correlation configuration depends on whether you are using the connector as an authoritative or regular source: 

- **Authoritative source**: When you use the connector as an authoritative source, reviewer accounts always get the identity’s UID as unique identifier. Therefore, when you use deduplication, you must set correlation between an identity’s UID and the account’s ID.

- **Regular source**: To correlate proxy accounts directly with corresponding identities, you must identify the account attributes the connector can match with identity attributes. This configuration depends on the actual data, and it's the same as any other source account correlation. 


## Account Aggregation Process 

You can find a diagram of the fusion connector's aggregation process here: [Account aggregation process diagram](https://miro.com/app/board/uXjVNgEpRGs=/)

<!-- CONTRIBUTING -->

## Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also simply open an issue with the tag `enhancement`.
Don't forget to give the project a star! Thanks again!

1. Fork the Project.
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`).
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`).
4. Push to the Branch (`git push origin feature/AmazingFeature`).
5. Open a Pull Request.

<!-- LICENSE -->

## License

Distributed under the MIT License. See `LICENSE.txt` for more information.

<!-- CONTACT -->

## Discuss

[Click Here](https://developer.sailpoint.com/dicuss/tag/{tagName}) to discuss this tool with other users.
