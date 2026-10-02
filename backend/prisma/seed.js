// Seed matches index.html mock data + PRD §4B example.
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const unilag = await prisma.institution.upsert({
    where: { name: "University of Lagos (UNILAG)" },
    update: {},
    create: {
      name: "University of Lagos (UNILAG)",
      location: "Akoka, Lagos",
      faculties: {
        create: [{
          name: "Faculty of Science",
          departments: {
            create: [
              { name: "Biology", programmes: { create: [{ name: "B.Sc. Biology" }, { name: "B.Sc. Microbiology" }] } },
              { name: "Chemistry", programmes: { create: [{ name: "B.Sc. Chemistry" }] } }
            ]
          }
        }]
      },
      hubPage: {
        create: {
          overview: "Federal university in Akoka, Lagos.",
          clearance: "JAMB admission letter, O-level results, birth certificate, LGA letter, passport photos.",
          fees: "See official portal; varies by faculty.",
          accommodation: "Hostels limited — apply early; private hostels in Akoka/Bariga.",
          source: "Official + Community"
        }
      }
    }
  });

  await prisma.institution.upsert({
    where: { name: "University of Ibadan (UI)" },
    update: {},
    create: {
      name: "University of Ibadan (UI)",
      location: "Ibadan, Oyo",
      faculties: { create: [{ name: "Faculty of Science", departments: { create: [{ name: "Biology", programmes: { create: [{ name: "B.Sc. Zoology" }] } }] } }] }
    }
  });

  await prisma.institution.upsert({
    where: { name: "Yaba College of Technology (YabaTech)" },
    update: {},
    create: {
      name: "Yaba College of Technology (YabaTech)",
      location: "Yaba, Lagos",
      faculties: { create: [{ name: "School of Science", departments: { create: [{ name: "Science Laboratory Technology", programmes: { create: [{ name: "ND SLT" }, { name: "HND SLT" }] } }] } }] }
    }
  });

  for (const m of [
    { name: "Tunde B.", dept: "Biology", school: "University of Lagos (UNILAG)", level: "300-level", areas: "Clearance, Accommodation, First-semester prep", verified: true },
    { name: "Mariam S.", dept: "Computer Science", school: "University of Ibadan (UI)", level: "200-level", areas: "Resumption, Study tips", verified: false }
  ]) await prisma.mentor.create({ data: m });

  console.log("Seeded:", unilag.name, "+ UI + YabaTech + 2 mentors");
}

main().finally(() => prisma.$disconnect());
