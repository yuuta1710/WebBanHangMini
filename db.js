const { Pool } = require('pg');
require('dotenv').config();

// Kiểm tra môi trường chạy hiện tại để kích hoạt SSL động thông minh
const isProduction = process.env.NODE_ENV === 'production';

// Khởi tạo Pool kết nối với chuỗi DATABASE_URL từ file .env
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // BẮT BUỘC BẬT SSL: Do Render yêu cầu tất cả kết nối (kể cả từ máy local) phải qua SSL/TLS
  ssl: {
    rejectUnauthorized: false
  }
});

// Hàm kiểm tra kết nối khi khởi động Server
const testConnection = async () => {
  try {
    const client = await pool.connect();
    console.log(isProduction ? '✅ Kết nối thành công tới PostgreSQL trên Render Cloud!' : '✅ Kết nối thành công tới PostgreSQL dưới máy Local!');
    
    // Thử lấy thời gian hiện tại của Database để chắc chắn thông suốt
    const res = await client.query('SELECT NOW()');
    console.log(`🕒 Giờ hệ thống Database: ${res.rows[0].now}`);
    
    client.release(); // Giải phóng kết nối lại vào Pool
  } catch (err) {
    console.error('❌ Lỗi kết nối Database thất bại:', err.message);
  }
};

testConnection();

const initializeDatabase = async () => {
  // Schema đầy đủ dùng cho lần cài đặt HOÀN TOÀN MỚI (database trống trơn)
  const createTablesQuery = `
    -- 1. Tạo bảng sản phẩm nếu chưa tồn tại (đã bao gồm category, discount_rate, original_price, created_at, và cột ảnh đổi tên thành "img" cho khớp Frontend)
    CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        price INT NOT NULL,
        img TEXT,
        description TEXT,
        stock_quantity INT NOT NULL DEFAULT 0,
        category VARCHAR(100),
        discount_rate INT NOT NULL DEFAULT 0,
        original_price INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP -- ✨ MỚI: phục vụ tab "Sản phẩm mới" lọc theo thời gian thực tế
    );

    -- 2. Tạo bảng đơn hàng giả lập nếu chưa tồn tại
    CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_code VARCHAR(50) UNIQUE NOT NULL, -- ✨ THÊM MỚI: Mã đơn hàng bảo mật hiển thị ra Frontend
        customer_name VARCHAR(255) NOT NULL,
        total_price INT NOT NULL,
        items JSONB NOT NULL, 
        status VARCHAR(30) NOT NULL DEFAULT 'pending', -- ✨ MỚI: Vòng đời đơn hàng: pending | confirmed | shipping | delivered | cancelled
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 3. ✨ MỚI: Tạo bảng thông báo (notifications) nếu chưa tồn tại, phục vụ trang "Thông báo" ở Frontend
    CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        type VARCHAR(20) NOT NULL DEFAULT 'system', -- Giá trị hợp lệ: 'sale' | 'new' | 'order' | 'system'
        title VARCHAR(255) NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 4. ✨ MỚI: Tạo bảng người dùng (users) phục vụ xác thực đăng nhập/đăng ký thật
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL, -- Lưu mật khẩu ĐÃ BĂM bằng bcrypt, không bao giờ lưu plain text
        role VARCHAR(20) NOT NULL DEFAULT 'customer', -- 'customer' | 'admin'
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  // ✨ MỚI: Các câu lệnh MIGRATION dành riêng cho database ĐÃ TỒN TẠI TỪ TRƯỚC
  // (CREATE TABLE IF NOT EXISTS ở trên sẽ bị bỏ qua hoàn toàn nếu bảng đã có sẵn,
  // nên các cột mới BẮT BUỘC phải được thêm riêng bằng ALTER TABLE bên dưới.
  // Toàn bộ khối này an toàn khi chạy lại nhiều lần - không văng lỗi nếu đã migrate rồi.)
  const migrationQuery = `
    -- Đổi tên cột image_url -> img (chỉ chạy khi image_url còn tồn tại và img chưa có)
    DO $$
    BEGIN
        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'products' AND column_name = 'image_url'
        ) AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'products' AND column_name = 'img'
        ) THEN
            ALTER TABLE products RENAME COLUMN image_url TO img;
        END IF;
    END $$;

    -- Bổ sung các cột mới cho bảng products nếu database cũ chưa có (IF NOT EXISTS đảm bảo an toàn khi chạy lại)
    ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(100);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_rate INT NOT NULL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS original_price INT;
    -- ✨ MỚI: Thêm created_at cho sản phẩm cũ. Postgres tự gán giá trị DEFAULT (thời điểm chạy lệnh này)
    -- cho toàn bộ các dòng đã tồn tại, nên các sản phẩm cũ sẽ tạm thời được xem là "mới" ngay sau khi migrate xong.
    ALTER TABLE products ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

    -- ✨ MỚI: Thêm cột status cho đơn hàng cũ (mặc định 'pending' cho các đơn đã có từ trước)
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'pending';
  `;

  try {
    // 1. Chạy lệnh tạo bảng (áp dụng cho cài đặt mới)
    await pool.query(createTablesQuery);
    console.log('📦 Cấu trúc các bảng (products, orders, notifications) đã sẵn sàng.');

    // 2. Chạy migration (áp dụng cho database cũ đã có dữ liệu từ trước)
    await pool.query(migrationQuery);
    console.log('🔧 Đã đồng bộ (migrate) cấu trúc cột mới nhất cho bảng products.');

    // 3. Tự động SEED dữ liệu mẫu nếu bảng products chưa có hàng nào
    const productCheck = await pool.query('SELECT COUNT(*) FROM products');
    if (parseInt(productCheck.rows[0].count) === 0) {
      console.log('🌱 Bảng sản phẩm đang trống. Tiến hành nạp dữ liệu mẫu...');
      
      const seedQuery = `
        INSERT INTO products (name, price, img, description, stock_quantity, category, discount_rate, original_price) VALUES
        ('Laptop Asus ROG Gaming', 24990000, 'https://picsum.photos/id/1/200/200', 'Laptop gaming hiệu năng cao', 10, 'Thiết Bị Công Nghệ', 0, NULL),
        ('Chuột Không Dây Logitech G304', 850000, 'https://picsum.photos/id/2/200/200', 'Chuột gaming quốc dân siêu nhạy', 15, 'Thiết Bị Công Nghệ', 15, 999000),
        ('Bàn Phím Cơ AKKO 3068', 1590000, 'https://picsum.photos/id/3/200/200', 'Bàn phím cơ nhỏ gọn, gõ êm', 5, 'Thiết Bị Công Nghệ', 0, NULL);
      `;
      
      await pool.query(seedQuery);
      console.log('🚀 Đã seed thành công 3 sản phẩm mẫu vào database!');
    } else {
      // ✨ MỚI: Backfill (gán bù) category mặc định cho các sản phẩm CŨ đã tồn tại từ trước khi có cột category
      const backfillResult = await pool.query(
        `UPDATE products SET category = 'Thiết Bị Công Nghệ' WHERE category IS NULL`
      );
      if (backfillResult.rowCount > 0) {
        console.log(`🔧 Đã tự động gán category mặc định cho ${backfillResult.rowCount} sản phẩm cũ chưa có category.`);
      }
    }

    // 4. ✨ MỚI: Tự động SEED dữ liệu mẫu cho notifications nếu bảng đang trống
    const notifyCheck = await pool.query('SELECT COUNT(*) FROM notifications');
    if (parseInt(notifyCheck.rows[0].count) === 0) {
      console.log('🌱 Bảng notifications đang trống. Tiến hành nạp dữ liệu mẫu...');

      const seedNotifyQuery = `
        INSERT INTO notifications (type, title, description) VALUES
        ('sale', 'Giảm giá sốc cuối tuần', 'Chuột Logitech G304 đang giảm 15%, số lượng có hạn!'),
        ('new', 'Sản phẩm mới ra mắt', 'Bàn phím cơ AKKO 3068 vừa được thêm vào cửa hàng.'),
        ('system', 'Chào mừng đến với MiniShop', 'Cảm ơn bạn đã ghé thăm cửa hàng của chúng tôi!');
      `;

      await pool.query(seedNotifyQuery);
      console.log('🚀 Đã seed thành công 3 thông báo mẫu vào database!');
    }
  } catch (err) {
    console.error('❌ Lỗi khởi tạo cấu trúc dữ liệu:', err.message);
  }
};

// Kích hoạt hàm khởi tạo
initializeDatabase();

module.exports = pool;