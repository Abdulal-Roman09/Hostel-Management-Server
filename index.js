const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
dotenv.config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// Load environment variables

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

const serviceAccount = require("./Firebase-Admin-Key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// MongoDB connection URI
const uri = `mongodb+srv://${process.env.DB_NAME}:${process.env.DB_PASS}@cluster0.1ssdisl.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // await client.connect();

    const database = client.db("hostelManagementDB");
    const recipesCollection = database.collection("recipes");
    const usersCollection = database.collection("users");
    const paymentsCollection = database.collection("Payments");
    const upcomingMealsCollection = database.collection("upcommingMeals");
    const reviewsCollection = database.collection("reviews");
    // custom middelward
    const verifyFBToken = async (req, res, next) => {
      try {
        const authHeader = req.headers.authorization;
        console.log("Authorization Header:", authHeader);

        if (!authHeader) {
          return res.status(401).send({ message: "unauthorized access" });
        }

        const token = authHeader.split(" ")[1];
        if (!token) {
          return res.status(401).send({ message: "unauthorized access" });
        }

        const decoded = await admin.auth().verifyIdToken(token);
        console.log("Decoded Firebase Token:", decoded); // লগিং

        req.decoded = decoded;
        next();
      } catch (error) {
        console.error("❌ Firebase token verification failed:", error);
        res.status(403).send({ message: "Forbidden" });
      }
    };

    const verifyAdmin = async (req, res, next) => {
      try {
        const email = req.decoded?.email;

        if (!email) {
          return res
            .status(401)
            .json({ success: false, message: "Unauthorized" });
        }

        const user = await req.app.locals.db
          .collection("users")
          .findOne({ email });

        if (!user || user.role !== "serverAdmin") {
          return res
            .status(403)
            .json({ success: false, message: "Forbidden: Server admin only" });
        }

        next();
      } catch (error) {
        console.error("Server admin check failed:", error);
        res
          .status(500)
          .json({ success: false, message: "Internal server error" });
      }
    };

    // crate usercollection
    app.post("/users", async (req, res) => {
      try {
        const user = req.body;
        const existingUser = await usersCollection.findOne({
          email: user.email,
        });
        if (existingUser) {
          const result = await usersCollection.updateOne(
            {
              email: user.email,
            },
            {
              $set: {
                last_login_at: new Date().toISOString(),
              },
            }
          );
          return res
            .status(200)
            .json({ message: "user login Updated", result });
        }
       
        const newUser = {
          email: user.email,
          role: "user",
          packages: "Bronze",
          created_at: new Date().toISOString(),
          last_login_at: new Date().toISOString(),
        };

        const result = await usersCollection.insertOne(newUser);
        res.status(201).json({ message: "New user created", result });
      } catch (error) {
        console.error("Error in /users route:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });
    app.get("/user/:email/role", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      try {
        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res
            .status(404)
            .json({ success: false, message: "User not found" });
        }

        res.json({ success: true, role: user.role });
      } catch (error) {
        console.log(error);
        res
          .status(500)
          .json({ success: false, message: "Internal Server Error" });
      }
    });
    app.patch("/users/:email/role", verifyFBToken, async (req, res) => {
      const userEmail = req.params.email;
      const { newRole } = req.body;

      if (!newRole) {
        return res
          .status(400)
          .send({ success: false, message: "Role missing" });
      }

      try {
        const result = await usersCollection.updateOne(
          { email: userEmail },
          { $set: { role: newRole } }
        );

        if (result.modifiedCount > 0) {
          res.send({ success: true, message: "Role updated to " + newRole });
        } else {
          res.send({
            success: false,
            message: "User not found or role unchanged",
          });
        }
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // update after payment userRole by eamil
    // User role update route
    app.patch("/users/:email/role-package", async (req, res) => {
      const userEmail = req.params.email;
      const { newRole, newPackage } = req.body;

      if (!newRole || !newPackage) {
        return res.status(400).send({
          success: false,
          message: "Missing role or package data.",
        });
      }

      try {
        const result = await usersCollection.updateOne(
          { email: userEmail },
          { $set: { role: newRole, packages: newPackage } }
        );

        if (result.modifiedCount > 0) {
          res.send({
            success: true,
            message: "Role and package updated.",
            updatedFields: { role: newRole, packages: newPackage },
          });
        } else {
          res.send({
            success: false,
            message: "No changes made or user not found.",
          });
        }
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });
    // all Payments
    app.post("/create-payment-intent", async (req, res) => {
      const {
        amount,
        userEmail,
        userName,
        productId,
        productName,
        package: selectedPackage,
      } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
      }

      try {
        const metadata = {
          userEmail,
          userName,
        };

        // Detect payment type and build metadata accordingly
        if (selectedPackage) {
          metadata.paymentType = "package";
          metadata.package = selectedPackage;
        } else if (productId && productName) {
          metadata.paymentType = "recipe";
          metadata.productId = productId;
          metadata.productName = productName;
        } else {
          return res
            .status(400)
            .json({ error: "Missing payment type information" });
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100),
          currency: "usd",
          payment_method_types: ["card"],
          metadata,
        });

        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // stripe all payments
    app.get("/stripe-payments", verifyFBToken, async (req, res) => {
      try {
        const payments = await stripe.paymentIntents.list();
        res.send({ success: true, data: payments.data });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });


    // mypayements
    app.post("/myPayments", async (req, res) => {
      const payment = req.body;
      try {
        const result = await paymentsCollection.insertOne(payment);
      } catch (error) {
        console.log(error);
      }
    });
    // GET all payments
    app.get("/myPayments", async (req, res) => {
      try {
        const payments = await paymentsCollection.find().toArray();
        res.status(200).json({ success: true, data: payments });
      } catch (error) {
        console.error(error);
        res
          .status(500)
          .json({ success: false, message: "Internal Server Error" });
      }
    });

    // Find my payments based on email
    app.get("/myPayments/:email", verifyFBToken, async (req, res) => {
      const email = req.params.email; 

      try {
        const payments = await paymentsCollection
          .find({
            "buyer.email": email,
          })
          .sort({ "transaction.date": -1 }) 
          .toArray();

        res.send({ success: true, data: payments });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });
    // PATCH: Update payment status by ID
    app.patch("/myPayments/:id/status", async (req, res) => {
      const { id } = req.params;
      const { status } = req.body;

      if (!status) {
        return res
          .status(400)
          .json({ success: false, message: "Status is required" });
      }

      try {
        const result = await paymentsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { "transaction.status": status } }
        );

        if (result.matchedCount === 0) {
          return res
            .status(404)
            .json({ success: false, message: "Payment not found" });
        }

        res
          .status(200)
          .json({ success: true, message: "Payment status updated" });
      } catch (error) {
        console.error("Error updating payment status:", error);
        res
          .status(500)
          .json({ success: false, message: "Internal Server Error" });
      }
    });

    // GET /users?search=abc&page=1&limit=10
    app.get("/users", async (req, res) => {
      const search = req.query.search || "";
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;

      const query = {
        email: { $regex: search, $options: "i" },
      };

      const skip = (page - 1) * limit;

      const users = await usersCollection
        .find(query)
        .skip(skip)
        .limit(limit)
        .toArray();
      const total = await usersCollection.countDocuments(query);

      res.send({
        users,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    });

    // recips  collection
    // POST /foods - Add new food item
    app.post("/foods", async (req, res) => {
      try {
        const food = req.body;
        console.log("Received food data:", food);

        const result = await recipesCollection.insertOne(food);

        res.send({
          success: true,
          message: "Food items added successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Error inserting food:", error);
        res.status(500).send({
          success: false,
          message: "Failed to add food item",
          error: error.message,
        });
      }
    });

    // GET /foods?email=someone@example.com
    app.get("/foods", async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const search = req.query.search || "";
        const category = req.query.category;

        const skip = (page - 1) * limit;

        // Build query object
        const query = {
          ...(category && category !== "All Meals" ? { category } : {}),
          ...(search ? { productName: { $regex: search, $options: "i" } } : {}),
        };

        // Find foods with sorting by Likes (descending)
        const foods = await recipesCollection
          .find(query)
          .sort({ Likes: -1 }) 
          .skip(skip)
          .limit(limit)
          .toArray();

        const total = await recipesCollection.countDocuments(query);

        res.send({ data: foods, total });
      } catch (error) {
        console.error("Error fetching paginated foods:", error);
        res.status(500).send("Server Error");
      }
    });

    // Get food by Categories with pagination
    app.get("/categorys", async (req, res) => {
      try {
        const category = req.query.category;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const filter = category ? { category } : {};

       
        const total = await recipesCollection.countDocuments(filter);


        const meals = await recipesCollection
          .find(filter)
          .skip(skip)
          .limit(limit)
          .toArray();

        res.send({ meals, total });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to fetch category-based meals",
          error: error.message,
        });
      }
    });

    // Get all Food
    app.get("/allFoods", async (req, res) => {
      const result = await recipesCollection.find().toArray();
      res.send(result);
    });
    app.put("/allFoods/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .send({ success: false, message: "Invalid food ID" });
        }

        const updatedData = req.body;

        if (updatedData._id) {
          delete updatedData._id;
        }

        const result = await recipesCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updatedData }
        );

        res.send({
          success: true,
          message: "Food item updated successfully",
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        console.error("Error updating food item:", error);
        res.status(500).send({
          success: false,
          message: "Failed to update food item",
          error: error.message,
        });
      }
    });

    app.delete("/allFoods/:id", async (req, res) => {
      const id = req.params.id;
      const result = await recipesCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });
    // upcomming meals

    app.post("/upcoming-meals", verifyAdmin, async (req, res) => {
      const meal = req.body;
      const result = await upcomingMealsCollection.insertOne(meal);
      res.send(result);
    });

    // Get upcomming all meals
    app.get("/upcoming-meals", async (req, res) => {
      try {
        const meals = await upcomingMealsCollection.find().toArray();
        res.send(meals);
      } catch (error) {
        console.error("Error fetching upcoming meals:", error);
        res.status(500).send({ message: "Failed to get upcoming meals" });
      }
    });

    // Get Upcoming meal by ID
    app.get("/upcoming-meals/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const meal = await upcomingMealsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!meal) {
          return res.status(404).json({ error: "Meal not found" });
        }

        res.json(meal);
      } catch (error) {
        console.error("Error fetching meal:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });
    // like and other nassery conditoon

    app.patch("/upcoming-meals/:id/likes", async (req, res) => {
      const mealId = req.params.id;

      if (!ObjectId.isValid(mealId)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }

      try {
        const result = await upcomingMealsCollection.findOneAndUpdate(
          { _id: new ObjectId(mealId) },
          { $inc: { likes: 1 } },
          { returnDocument: "after" }
        );

        const updatedMeal = result.value;

        if (!updatedMeal) {
          return res.status(404).json({ error: "Meal not found" });
        }


        if (updatedMeal.likes >= 10) {
          const { _id, ...mealWithoutId } = updatedMeal;

          await recipesCollection.insertOne({
            ...mealWithoutId,
            publishedAt: new Date(),
          });

          await upcomingMealsCollection.deleteOne({
            _id: new ObjectId(mealId),
          });

          return res.json({
            message: "Meal moved to recipes collection",
            likes: updatedMeal.likes,
            published: true,
          });
        }
        res.json({
          message: "Like added",
          likes: updatedMeal.likes,
          published: false,
        });
      } catch (error) {
        console.error("Like patch error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });

    // add comments
    app.post("/foods/:id/comments", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const newComment = req.body; 

      try {
        const result = await recipesCollection.updateOne(
          { _id: new ObjectId(id) },
          { $push: { comments: newComment } }
        );

        if (result.modifiedCount === 0) {
          return res
            .status(404)
            .send({ success: false, message: "Meal not found or not updated" });
        }

        res.send({ success: true, message: "Comment added successfully" });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Get comments
    app.get("/foods/:id/comments", async (req, res) => {
      const id = req.params.id;
      try {
        const meal = await recipesCollection.findOne(
          { _id: new ObjectId(id) },
          { projection: { comments: 1 } }
        );

        if (!meal) {
          return res
            .status(404)
            .send({ success: false, message: "Meal not found" });
        }

        res.send({ success: true, comments: meal.comments || [] });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // GET /foods/:id
    app.get("/foods/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const meal = await recipesCollection.findOne(query);

        if (!meal) {
          return res
            .status(404)
            .send({ success: false, message: "Meal not found" });
        }

        res.send({ success: true, data: meal });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Error fetching meal",
          error: error.message,
        });
      }
    });

    // update like
    app.patch("/foods/:id/likes", async (req, res) => {
      const { id } = req.params;
      try {
        const result = await recipesCollection.updateOne(
          {
            _id: new ObjectId(id),
          },
          {
            $inc: {
              Likes: 1,
            },
          }
        );
        if (result.matchedCount > 0) {
          res.send({
            success: true,
            message: "Like count updated successfully",
          });
        } else {
          res.status(404).send({
            success: false,
            message: "Product not found or already liked",
          });
        }
      } catch (error) {
        console.error("Error updating like count:", error);
        res.status(500).send({
          success: false,
          message: "Failed to update like count",
          error: error.message,
        });
      }
    });

    // delete food based on id
    app.delete("/foods/:id", async (req, res) => {
      const id = req.params.id;
      try {
        const query = { _id: new ObjectId(id) };
        const result = await recipesCollection.deleteOne(query);
        if (result.deletedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "Food item not found",
          });
        }
        res.send({
          success: true,
          message: "Food item deleted successfully",
        });
      } catch (error) {
        console.error("Error deleting food item:", error);
        res.status(500).send({
          success: false,
          message: "Failed to delete food item",
          error: error.message,
        });
      }
    });
    // Reviews
    app.post("/reviews", async (req, res) => {
      const { mealId, userName, userEmail, userPhoto, text, createdAt } =
        req.body;

      if (!mealId || !text) {
        return res
          .status(400)
          .send({ success: false, message: "Meal ID and text required" });
      }

      try {
        const review = {
          mealId: new ObjectId(mealId),
          userName,
          userEmail,
          userPhoto,
          text,
          createdAt: createdAt ? new Date(createdAt) : new Date(),
        };

        const result = await reviewsCollection.insertOne(review);

        res.send({ success: true, insertedId: result.insertedId });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Get Reviews by eamil
    app.get("/reviews", verifyFBToken, async (req, res) => {
      const { email } = req.query;

      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      try {
        const reviews = await reviewsCollection
          .find({ userEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(reviews);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // Get Delete by id
    app.delete("/reviews/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;

      try {
        const result = await reviewsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 1) {
          res.send({ success: true });
        } else {
          res.status(404).send({ success: false, message: "Review not found" });
        }
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Test MongoDB connection ping
    // await client.db("admin").command({ ping: 1 });
    console.log("✅ Connected to MongoDB and API routes are set up ping 1");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
  }
}

run().catch(console.dir);

// Basic test route
app.get("/", (req, res) => {
  res.send("🚀 Server is running!");
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
