import csv
import random
import faker

# Initialize Faker
fake = faker.Faker()

# Parameters
num_entries = 50000
countries = ["USA", "Canada", "UK", "Germany", "France"]
departments = ["Engineering", "Product", "Data Science", "Human Resources", "Sales"]
titles = [
    "Software Engineer",
    "Product Manager",
    "Data Analyst",
    "HR Specialist",
    "Sales Representative",
]
statuses = ["active", "inactive"]

# Create CSV
with open("employees.csv", "w", newline="") as csvfile:
    fieldnames = [
        "employeeNumber",
        "username",
        "givenName",
        "familyName",
        "displayName",
        "mail",
        "status",
        "title",
        "country",
        "department",
        "region",
    ]
    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)

    writer.writeheader()

    for employee_number in range(1, num_entries + 1):
        given_name = fake.first_name()
        family_name = fake.last_name()
        username = f"{given_name[0].lower()}{family_name.lower()}"
        display_name = f"{given_name} {family_name}"
        mail = f"{username}@example.com"
        status = random.choice(statuses)
        title = random.choice(titles)
        country = random.choice(countries)
        department = random.choice(departments)
        region = "North America" if country in ["USA", "Canada"] else "Europe"

        writer.writerow(
            {
                "employeeNumber": employee_number,
                "username": username,
                "givenName": given_name,
                "familyName": family_name,
                "displayName": display_name,
                "mail": mail,
                "status": status,
                "title": title,
                "country": country,
                "department": department,
                "region": region,
            }
        )
