-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "password" TEXT,
    "type" TEXT NOT NULL DEFAULT 'prospective',
    "school" TEXT,
    "faculty" TEXT,
    "dept" TEXT,
    "programme" TEXT,
    "session" TEXT,
    "interests" TEXT,
    "photoPath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Institution" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "location" TEXT
);

-- CreateTable
CREATE TABLE "Faculty" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "institutionId" INTEGER NOT NULL,
    CONSTRAINT "Faculty_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Department" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "facultyId" INTEGER NOT NULL,
    CONSTRAINT "Department_facultyId_fkey" FOREIGN KEY ("facultyId") REFERENCES "Faculty" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Programme" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "departmentId" INTEGER NOT NULL,
    CONSTRAINT "Programme_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Connection" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "fromId" INTEGER NOT NULL,
    "toId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'accepted',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Connection_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Connection_toId_fkey" FOREIGN KEY ("toId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Post" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "school" TEXT NOT NULL,
    "authorId" INTEGER,
    "authorName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Mentor" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "dept" TEXT,
    "school" TEXT,
    "level" TEXT,
    "areas" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "HubPage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "institutionId" INTEGER NOT NULL,
    "overview" TEXT,
    "clearance" TEXT,
    "fees" TEXT,
    "accommodation" TEXT,
    "source" TEXT NOT NULL DEFAULT 'Community',
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HubPage_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Report" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "target" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "reporterId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Report_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Institution_name_key" ON "Institution"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Faculty_institutionId_name_key" ON "Faculty"("institutionId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Department_facultyId_name_key" ON "Department"("facultyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Programme_departmentId_name_key" ON "Programme"("departmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Connection_fromId_toId_key" ON "Connection"("fromId", "toId");

-- CreateIndex
CREATE UNIQUE INDEX "HubPage_institutionId_key" ON "HubPage"("institutionId");
